import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";
import { createHistoryDatabase } from "./history-db.ts";
import { parseMuniConfig, serializeMuniConfig } from "./config.ts";
import { normalizeOcrName, stabilizeOcrName } from "./name-normalization.ts";
import { createPpOcrClient } from "./ppocr-client.ts";
import { assertScoreContinuity, selectLeaderboardScores } from "./score-validation.ts";
import type { Capture, CollectorState, MuniConfig, OcrRow, RankingEntry } from "./types.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = path.join(ROOT, "config", "muni.yml");
const STATE_FILE = path.join(ROOT, "data", "state.json");
const SCREENSHOT_FILE = path.join(ROOT, "data", "latest.png");
const HISTORY_DB_FILE = path.join(ROOT, "data", "muni-watch.sqlite");
const REMOTE_SCREENSHOT = "/sdcard/muni-watch-latest.png";
const PORT = 4317;

const rows: OcrRow[] = [
  { rank: 1, name: { left: 438, top: 235, width: 285, height: 36 }, score: { left: 960, top: 304, width: 180, height: 36 } },
  { rank: 2, name: { left: 438, top: 372, width: 285, height: 36 }, score: { left: 960, top: 440, width: 180, height: 36 } },
  { rank: 3, name: { left: 438, top: 508, width: 285, height: 36 }, score: { left: 960, top: 576, width: 180, height: 36 } },
  { rank: 4, name: { left: 438, top: 645, width: 285, height: 36 }, score: { left: 960, top: 713, width: 180, height: 36 } },
  { rank: 5, name: { left: 438, top: 781, width: 285, height: 36 }, score: { left: 960, top: 849, width: 180, height: 36 } },
  { rank: 6, name: { left: 438, top: 918, width: 285, height: 36 }, score: { left: 960, top: 986, width: 180, height: 36 } },
  { rank: 7, name: { left: 438, top: 1054, width: 285, height: 36 }, score: { left: 960, top: 1122, width: 180, height: 36 } },
];

await mkdir(path.join(ROOT, "data"), { recursive: true });
let config: MuniConfig;
try {
  config = parseMuniConfig(await readFile(CONFIG_FILE, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("config/muni.yml was not found. Copy config/muni.example.yml and customize it before starting.");
  }
  throw error;
}
const defaultState: CollectorState = {
  status: "booting", lastUpdated: null, lastError: null, history: [],
  mumu: { name: config.deviceName, connected: false, screen: "unknown" }, ocr: null,
};
let state: CollectorState;
try {
  state = JSON.parse(await readFile(STATE_FILE, "utf8")) as CollectorState;
  state.mumu.name = config.deviceName;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  state = defaultState;
}
const historyDatabase = createHistoryDatabase(HISTORY_DB_FILE);
historyDatabase.backfill(state.history);
const ocrClient = createPpOcrClient({ root: ROOT, config: config.ocr });
let capturePromise: Promise<ReturnType<typeof publicState>> | null = null;
let intervalHandle: NodeJS.Timeout | null = null;

function sleep(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }

async function adb(args: string[], timeout = 15000) {
  return execFileAsync(config.adbPath, args, { cwd: ROOT, timeout, windowsHide: true });
}

async function connectMuMu() {
  await adb(["connect", config.serial], 10000);
  const { stdout } = await adb(["-s", config.serial, "get-state"], 10000);
  if (!stdout.toLowerCase().includes("device")) throw new Error("MuMuのADBに接続できません");
  state.mumu.connected = true;
}

async function takeScreenshot() {
  await adb(["-s", config.serial, "shell", "screencap", "-p", REMOTE_SCREENSHOT], 15000);
  await adb(["-s", config.serial, "pull", REMOTE_SCREENSHOT, SCREENSHOT_FILE], 15000);
}

async function isRankingScreen() {
  const image = sharp(SCREENSHOT_FILE);
  const metadata = await image.metadata();
  if (metadata.width !== config.screen.width || metadata.height !== config.screen.height) {
    throw new Error(`MuMuの解像度を${config.screen.width}×${config.screen.height}に設定してください（現在：${metadata.width}×${metadata.height}）`);
  }
  const { data } = await image.extract({ left: 300, top: 120, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [red, green, blue] = data;
  return blue > 130 && green < 105 && red < 145;
}

async function ensureTop20() {
  await takeScreenshot();

  // The game does not refresh the leaderboard while the TOP20 screen remains
  // open. Leave the ranking screen first so re-entering it triggers a fresh
  // server fetch, matching the manual in-game refresh flow.
  if (await isRankingScreen()) {
    await adb(["-s", config.serial, "shell", "input", "tap", String(config.taps.back.x), String(config.taps.back.y)]);
    await sleep(config.waitAfterBackMs);
    await takeScreenshot();
    if (await isRankingScreen()) throw new Error("TOP20画面からイベントトップへ戻れませんでした");
  }

  await adb(["-s", config.serial, "shell", "input", "tap", String(config.taps.ranking.x), String(config.taps.ranking.y)]);
  await sleep(config.waitAfterRankingMs);
  await adb(["-s", config.serial, "shell", "input", "tap", String(config.taps.top20.x), String(config.taps.top20.y)]);
  await sleep(config.waitAfterTop20Ms);
  await takeScreenshot();
  if (!(await isRankingScreen())) throw new Error("TOP20画面を開けませんでした。ゲームをイベントトップ画面に戻してください");
}

function cleanName(raw: unknown) {
  return normalizeOcrName(raw, config.nameCorrections);
}

async function readEntries() {
  const previousEntries = state.history.at(-1)?.entries ?? [];
  const activeRows = rows.slice(0, config.maxEntries);
  const recognition = await ocrClient.recognize({ imagePath: SCREENSHOT_FILE, rows: activeRows });
  const selectedScores = selectLeaderboardScores(recognition.entries);
  const entries: RankingEntry[] = recognition.entries.map((recognized, index) => {
    let name = cleanName(recognized.name.text);
    if (!name) name = previousEntries.find((entry) => entry.rank === recognized.rank)?.name ?? `Unknown #${recognized.rank}`;
    const score = selectedScores[index].score;
    return {
      rank: recognized.rank,
      name: stabilizeOcrName(name, score, state.history.slice(-288), config.nameCorrections),
      score,
      confidence: Math.round((recognized.name.confidence ?? 0) * 100),
    };
  });
  assertScoreContinuity(entries, state.history.slice(-288));
  state.ocr = {
    engine: recognition.engine.engine,
    model: recognition.engine.model,
    device: recognition.engine.device,
    gpu: recognition.engine.gpu,
  };
  return entries;
}

function publicState() {
  return {
    ...state,
    config: { intervalMinutes: config.intervalMinutes, auto: config.auto, eventName: config.eventName, leaderboard: config.leaderboard, maxEntries: config.maxEntries },
  };
}

async function persist() {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(CONFIG_FILE, serializeMuniConfig(config), "utf8");
}

async function runCapture() {
  if (capturePromise) return capturePromise;
  capturePromise = (async () => {
    state.status = "capturing";
    state.lastError = null;
    await persist();
    try {
      await connectMuMu();
      await ensureTop20();
      const entries = await readEntries();
      const capturedAt = new Date().toISOString();
      const capture: Capture = { id: `${Date.now()}`, capturedAt, entries };
      historyDatabase.insert(capture);
      state.history.push(capture);
      state.history = state.history.slice(-288);
      state.lastUpdated = capturedAt;
      state.status = "idle";
      state.mumu.screen = "TOP20";
    } catch (error) {
      state.status = "error";
      state.mumu.connected = false;
      state.lastError = error instanceof Error ? error.message : String(error);
    }
    await persist();
    return publicState();
  })().finally(() => { capturePromise = null; });
  return capturePromise;
}

function schedule() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  if (config.auto) intervalHandle = setInterval(() => void runCapture(), config.intervalMinutes * 60_000);
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
      response.end(); return;
    }
    if (request.method === "GET" && request.url === "/api/state") { sendJson(response, 200, publicState()); return; }
    if (request.method === "GET" && requestUrl.pathname === "/api/history") {
      const hours = Math.min(168, Math.max(1, Number(requestUrl.searchParams.get("hours")) || 24));
      const maxPoints = Math.min(480, Math.max(40, Number(requestUrl.searchParams.get("maxPoints")) || 240));
      sendJson(response, 200, { history: historyDatabase.query({ hours, maxPoints }), hours }); return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/pace") {
      sendJson(response, 200, { hours: 1, players: historyDatabase.fitPaces({ hours: 1 }) }); return;
    }
    if (request.method === "POST" && request.url === "/api/capture") { sendJson(response, 200, await runCapture()); return; }
    if (request.method === "POST" && request.url === "/api/settings") {
      const body = await readBody(request);
      if (typeof body.intervalMinutes === "number") config.intervalMinutes = Math.min(60, Math.max(1, Math.round(body.intervalMinutes)));
      if (typeof body.auto === "boolean") config.auto = body.auto;
      await persist(); schedule(); sendJson(response, 200, publicState()); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/latest.png")) {
      const image = await readFile(SCREENSHOT_FILE);
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      response.end(image); return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`むに Watch collector: http://127.0.0.1:${PORT}`);
  schedule();
  setTimeout(() => void runCapture(), 800);
});

async function shutdown() {
  if (intervalHandle) clearInterval(intervalHandle);
  await ocrClient.close();
  historyDatabase.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
