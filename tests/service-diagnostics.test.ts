import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServiceDiagnostics, runBackgroundCapture } from "../collector/service-diagnostics.ts";

test("unhandled background rejection exits a real Node process", () => {
  const result = spawnSync(process.execPath, ["-e", "setTimeout(() => void Promise.reject(new Error('Synthetic persistence failure')), 0)"],
    { encoding: "utf8", env: { NODE_ENV: "test" }, windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Synthetic persistence failure/);
});

test("lifecycle events persist child exit metadata in a file owned by one process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "muni-lifecycle-"));
  try {
    const log = createServiceDiagnostics(root, "synthetic_service");
    log("child_exit", { child: "frontend", childPid: 123, exitCode: 1, signal: null });
    const dir = path.join(root, "data", "service-logs");
    assert.deepEqual(await readdir(dir), [`synthetic_service-${process.pid}.jsonl`]);
    const event = JSON.parse(await readFile(path.join(dir, `synthetic_service-${process.pid}.jsonl`), "utf8"));
    assert.equal(event.child, "frontend");
    assert.equal(event.exitCode, 1);
    assert.equal(event.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(event.at)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("background persistence rejection is handled and later captures can still run", async () => {
  const failure = new Error("Synthetic persistence failure");
  const errors: unknown[] = [];
  await runBackgroundCapture(async () => { throw failure; }, error => { errors.push(error); });
  assert.equal(errors.length, 1);
  assert.equal(errors[0], failure);
  let captured = false;
  await runBackgroundCapture(async () => { captured = true; }, error => { errors.push(error); });
  assert.equal(captured, true);
  assert.equal(errors.length, 1);
});
