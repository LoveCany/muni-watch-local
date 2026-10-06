import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeCapture, validateRuntimeRanking } from "../collector/il2cpp-client.ts";
import { parseMuniConfig, serializeMuniConfig } from "../collector/config.ts";
import { readFile } from "node:fs/promises";

function snapshot() {
  return { eventId: 123, capturedAt: "2026-01-01T00:00:00.000Z", entries: Array.from({ length: 20 }, (_, i) =>
    ({ rank: i + 1, name: `Synthetic player ${i + 1}`, score: 1000000 - i * 100 })) };
}

test("runtime cleanup status distinguishes retryable view errors from pending native work", () => {
  assert.deepEqual(parseRuntimeCapture({ status: "ok", ...snapshot() }), { status: "ok", result: snapshot() });
  for (const pending of [false, true]) {
    const reply = { status: "failed", pending, error: "The ranking list has not loaded" };
    assert.deepEqual(parseRuntimeCapture(reply), reply);
  }
  for (const reply of [null, snapshot(), { status: "failed", error: "Missing cleanup status" },
    { status: "failed", pending: "false", error: "Invalid status" },
    { status: "failed", pending: false, error: "x".repeat(257) }]) {
    assert.throws(() => parseRuntimeCapture(reply), /status/);
  }
});
test("direct capture keeps exact nicknames and integer scores without OCR correction", () => {
  const value = snapshot();
  value.entries[0].name = "Synthetic Ⅰ  Player";
  assert.deepEqual(validateRuntimeRanking(value), value);
});
test("direct capture rejects partial, duplicate and descending-score violations", () => {
  const partial = snapshot(); partial.entries.pop();
  assert.throws(() => validateRuntimeRanking(partial), /complete/);
  const duplicate = snapshot(); duplicate.entries[1].rank = 1;
  assert.throws(() => validateRuntimeRanking(duplicate), /rank/);
  const disorder = snapshot(); disorder.entries[1].score += 1000000;
  assert.throws(() => validateRuntimeRanking(disorder), /descending/);
  const invalid = snapshot(); invalid.entries[0].score = NaN;
  assert.throws(() => validateRuntimeRanking(invalid), /score/);
});
test("IL2CPP is the default and OCR requires an explicit mode and its own entry limit", async () => {
  const source = await readFile(new URL("../config/muni.example.yml", import.meta.url), "utf8");
  const runtime = parseMuniConfig(source);
  assert.equal(runtime.captureMode, "il2cpp");
  assert.deepEqual(parseMuniConfig(serializeMuniConfig(runtime)), runtime);
  assert.throws(() => parseMuniConfig(source.replace("maxEntries: 20", "maxEntries: 7")), /maxEntries/);
  const implicit = parseMuniConfig(source.replace(/captureMode: il2cpp\r?\n/, ""));
  assert.equal(implicit.captureMode, "il2cpp");
  assert.equal(implicit.maxEntries, 20);
  const ocr = parseMuniConfig(source.replace("captureMode: il2cpp", "captureMode: ocr").replace("maxEntries: 20", "maxEntries: 7"));
  assert.equal(ocr.captureMode, "ocr");
  assert.equal(ocr.maxEntries, 7);
  assert.throws(() => parseMuniConfig(source.replace("captureMode: il2cpp", "captureMode: ocr")), /maxEntries/);
});
