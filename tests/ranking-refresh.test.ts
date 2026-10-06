import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { isRankingImage, landscape1080, refreshTop20 } from "../collector/ranking-refresh.ts";
import { acquireRuntimeOwner } from "../collector/runtime-owner.ts";

const config = { ...landscape1080, waitAfterBackMs: 1, waitAfterRankingMs: 2, waitAfterTop20Ms: 3 };
function actions(states: boolean[], calls: string[]) {
  return {
    screenshot: async () => { calls.push("screenshot"); },
    isRanking: async () => states.shift() ?? false,
    tap: async ({ x, y }: { x: number; y: number }) => { calls.push(x + "," + y); },
    wait: async (ms: number) => { calls.push("wait:" + ms); },
  };
}
test("refresh leaves ranking, re-enters it and selects TOP20 before reading", async () => {
  const calls: string[] = [];
  await refreshTop20(config, actions([true, false, true, true], calls));
  assert.deepEqual(calls, ["screenshot", "75,60", "wait:1", "screenshot", "655,400", "wait:2", "screenshot", "960,280", "wait:3", "screenshot"]);
});
test("refresh from event home skips back and aborts a failed exit", async () => {
  const calls: string[] = [];
  await refreshTop20(config, actions([false, true, true], calls));
  assert.ok(!calls.includes("75,60"));
  const failed: string[] = [];
  await assert.rejects(refreshTop20(config, actions([true, true], failed)), /leave/);
  assert.ok(!failed.includes("655,400"));
});
test("landscape marker accepts ranking purple, rejects event home and wrong resolution", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muni-refresh-"));
  try {
    const file = path.join(dir, "screen.png");
    await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 93, g: 42, b: 182 } } }).composite([{ input: Buffer.from([91, 231, 226]), raw: { width: 1, height: 1, channels: 3 }, left: 166, top: 185 }]).png().toFile(file);
    assert.equal(await isRankingImage(file, landscape1080.screen), true);
    await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 93, g: 42, b: 182 } } }).png().toFile(file);
    assert.equal(await isRankingImage(file, landscape1080.screen), false);
    await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 251, g: 189, b: 244 } } }).png().toFile(file);
    assert.equal(await isRankingImage(file, landscape1080.screen), false);
    await assert.rejects(isRankingImage(file, { width: 1280, height: 1280 }), /resolution/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("only one reader owns a process; unresolved owner survives until a new game process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muni-owner-"));
  try {
    const first = await acquireRuntimeOwner(dir, 123);
    await assert.rejects(acquireRuntimeOwner(dir, 123), /already/);
    const next = await acquireRuntimeOwner(dir, 456);
    await next();
    await first();
    await (await acquireRuntimeOwner(dir, 123))();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("refresh waits for a delayed ranking response and retries a disabled TOP20 tab", async () => {
  const calls: string[] = [];
  const base = actions([false, false, true, true], calls);
  const selected = [false, true];
  await refreshTop20(config, { ...base, isTop20: async () => selected.shift() ?? true });
  assert.equal(calls.filter(value => value === "960,280").length, 2);
  assert.ok(calls.includes("wait:500"));
});
test("refresh has a finite wait when the ranking screen never appears", async () => {
  const calls: string[] = [];
  await assert.rejects(refreshTop20(config, actions([], calls)), /load in time/);
  assert.equal(calls.filter(value => value === "wait:500").length, 19);
  assert.ok(!calls.includes("960,280"));
});
