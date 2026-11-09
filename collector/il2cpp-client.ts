import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type * as frida from "frida";
import { createRuntimeAgentSource } from "./runtime-profile.ts";
import type { MuniConfig, RuntimeRankingResult } from "./types.ts";
import { acquireRuntimeOwner } from "./runtime-owner.ts";
import { withOperationDeadline } from "./operation-deadline.ts";
import { identifyLeaderboard } from "./leaderboards.ts";
import { ensureRuntimeHelper } from "./runtime-helper.ts";

const execute = promisify(execFile);
export function validateRuntimeRanking(value: unknown): RuntimeRankingResult {
  if (!value || typeof value !== "object") throw new Error("Invalid IL2CPP ranking response");
  const result = value as Record<string, unknown>;
  if (typeof result.eventId !== "number" || !Number.isSafeInteger(result.eventId) || result.eventId <= 0)
    throw new Error("A valid current event ID is required");
  if (typeof result.capturedAt !== "string" || !Number.isFinite(Date.parse(result.capturedAt)) ||
      !Array.isArray(result.entries) || result.entries.length !== 20) throw new Error("A complete timestamped TOP20 is required");
  const board = identifyLeaderboard(result.rankingName, result.dayNumber);
  const entries = result.entries.map((value: unknown, index: number) => {
    if (!value || typeof value !== "object") throw new Error("Invalid IL2CPP ranking row");
    const entry = value as Record<string, unknown>;
    if (entry.rank !== index + 1 || typeof entry.name !== "string" || !entry.name.length || entry.name.length > 256 ||
        typeof entry.score !== "number" || !Number.isSafeInteger(entry.score) || entry.score < 0) throw new Error("Invalid IL2CPP rank, nickname or score");
    return { rank: index + 1, name: entry.name, score: entry.score };
  });
  if (entries.some((entry, index) => index > 0 && entry.score > entries[index - 1].score)) throw new Error("IL2CPP scores are not descending");
  return { capturedAt: result.capturedAt, entries, eventId: result.eventId, ...board };
}
export function parseRuntimeCapture(value: unknown):
  { status: "ok"; result: RuntimeRankingResult } | { status: "failed"; pending: boolean; error: string } {
  if (!value || typeof value !== "object") throw new Error("Invalid runtime operation status");
  const reply = value as Record<string, unknown>;
  if (reply.status === "ok") return { status: "ok", result: validateRuntimeRanking(reply) };
  if (reply.status === "failed" && typeof reply.pending === "boolean" && typeof reply.error === "string" && reply.error.length <= 256)
    return { status: "failed", pending: reply.pending, error: reply.error };
  throw new Error("Invalid runtime operation status");
}

export function createIl2CppClient(root: string, config: Pick<MuniConfig, "adbPath" | "serial">,
                                 progress: (stage: string) => void = () => {}) {
  let session: frida.Session | null = null;
  let script: frida.Script | null = null;
  let processId = 0;
  let blocked = false;
  let releaseOwner: (() => Promise<void>) | null = null;
  let runtime: typeof import("frida") | null = null;
  async function adb(...args: string[]) {
    return (await execute(config.adbPath, ["-s", config.serial, ...args], { timeout: 15000, windowsHide: true })).stdout.trim();
  }
  async function deadline<T>(operation: (cancel: frida.Cancellable) => Promise<T>): Promise<T> {
    if (!runtime) throw new Error("Frida runtime is not initialized");
    const cancel = new runtime.Cancellable();
    return withOperationDeadline(() => operation(cancel), () => { blocked = true; cancel.cancel(); });
  }
  async function close() {
    progress("close_reader");
    if (blocked && session && !session.isDetached()) throw new Error("Unresolved IL2CPP operation; no cleanup RPC was retried");
    if (script && session && !session.isDetached()) {
      const result: unknown = await deadline((cancel) => script!.exports.close(cancel));
      if (!result || typeof result !== "object" || (result as Record<string, unknown>).status !== "released") {
        blocked = true; throw new Error("IL2CPP main-thread read remains pending; resources retained");
      }
    }
    if (session && !session.isDetached()) await deadline((cancel) => session!.detach(cancel));
    script = null; session = null; processId = 0;
    if (releaseOwner) { await releaseOwner(); releaseOwner = null; }
  }
  async function attach(pid: number) {
    const profile: unknown = JSON.parse(await readFile(path.join(root, "config", "il2cpp-runtime.json"), "utf8"));
    const helper = path.join(root, "collector", "native", "unity_invoke.so");
    const helperBytes = await readFile(helper);
    const digest = createHash("sha256").update(helperBytes).digest("hex");
    const helperPath = `/data/local/tmp/muni-unity-invoke-${digest}.so`;
    const source = createRuntimeAgentSource(profile, helperPath, helperBytes);
    releaseOwner = await acquireRuntimeOwner(path.join(root, "data"), pid);
    const frida = runtime = await import("frida");
    progress("verify_runtime");
    const server = await adb("shell", "pidof", "frida-server");
    if (!/^\d+$/.test(server) || await adb("shell", "su", "-c", `'/proc/${server}/exe --version'`) !== "17.20.0")
      throw new Error("Start the matching Frida 17.20.0 server on the rooted emulator first");
    await ensureRuntimeHelper(adb, helper, helperPath, digest);
    const device = await frida.getDevice(config.serial, { timeout: 10000 });
    progress("attach");
    session = await deadline((cancel) => device.attach(pid, {}, cancel));
    session.detached.connect((reason) => progress("session_detached:"+reason));
    script = await deadline((cancel) => session!.createScript(source, {}, cancel));
    script.message.connect((message) => {
      if (message.type === frida.MessageType.Send && message.payload && typeof message.payload === "object") {
        const payload = message.payload as Record<string, unknown>;
        if (typeof payload.stage === "string" && /^[a-z0-9_]+$/.test(payload.stage)) {
          const method = typeof payload.method === "string" && /^[A-Za-z_]+$/.test(payload.method) ? payload.method : "";
          progress(payload.stage+(method ? ":"+method : ""));
        }
      }
    });
    progress("load_reader");
    await deadline((cancel) => script!.load(cancel)); processId = pid;
  }
  return {
    async capture(): Promise<RuntimeRankingResult> {
      const pid = Number(await adb("shell", "pidof", "com.bushiroad.d4dj"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Exactly one running game process is required");
      if (session?.isDetached()) {
        if (pid === processId) throw new Error("Runtime session disconnected from the same game process; retained roots require recovery");
        script = null; session = null; processId = 0; blocked = false;
        if (releaseOwner) { await releaseOwner(); releaseOwner = null; }
      }
      if (blocked) throw new Error("A previous IL2CPP operation is unresolved; no new attachment was attempted");
      if (pid !== processId) { await close(); await attach(pid); }
      progress("capture");
      let reply: ReturnType<typeof parseRuntimeCapture>;
      try {
        reply = parseRuntimeCapture(await deadline((cancel) => script!.exports.capture(cancel)));
      } catch (error) {
        blocked = true;
        throw error;
      }
      if (reply.status === "failed") {
        blocked = reply.pending;
        throw new Error(reply.error);
      }
      return reply.result;
    }, close,
    async dispose() {
      await close();
      // Final process shutdown must also close Frida's device manager before Node tears down the addon.
      if (runtime) await deadline(cancel => runtime!.getDeviceManager().close(cancel));
    },
  };
}
