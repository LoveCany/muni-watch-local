import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseMuniConfig, serializeMuniConfig, validateMuniConfig } from "../collector/config.ts";

const validSource = await readFile(new URL("../config/muni.example.yml", import.meta.url), "utf8");

test("parses and validates the production YAML configuration", () => {
  const config = parseMuniConfig(validSource);
  assert.deepEqual(config.screen, { width: 1920, height: 1080 });
  assert.equal(config.deviceName, "Android Device");
  assert.equal(config.maxEntries, 20);
  assert.deepEqual(config.taps.ranking, { x: 655, y: 400 });
});

test("round-trips a valid configuration through YAML", () => {
  const original = parseMuniConfig(validSource);
  const restored = parseMuniConfig(serializeMuniConfig(original));
  assert.deepEqual(restored, original);
});

test("rejects malformed YAML and duplicate keys", () => {
  assert.throws(() => parseMuniConfig("screen: [1280\n"), /設定YAMLを解析できません/);
  assert.throws(() => parseMuniConfig(`${validSource}\nauto: false\n`), /設定YAMLを解析できません/);
});

test("rejects missing, unknown, and incorrectly typed fields", () => {
  const valid = parseMuniConfig(validSource);
  const withoutSerial: Record<string, unknown> = { ...valid };
  delete withoutSerial.serial;
  assert.throws(() => validateMuniConfig(withoutSerial), /必須項目.*serial/);
  assert.throws(() => validateMuniConfig({ ...valid, unexpected: true }), /未定義の項目.*unexpected/);
  assert.throws(() => validateMuniConfig({ ...valid, auto: "true" }), /auto.*true または false/);
});

test("rejects unsupported entry counts, intervals, and tap coordinates", () => {
  const valid = parseMuniConfig(validSource);
  assert.throws(() => validateMuniConfig({ ...valid, maxEntries: 8 }), /maxEntries.*20～20/);
  assert.throws(() => validateMuniConfig({ ...valid, intervalMinutes: 0 }), /intervalMinutes.*1～60/);
  assert.throws(() => validateMuniConfig({
    ...valid,
    taps: { ...valid.taps, ranking: { x: 439, y: valid.screen.height } },
  }), /taps\.ranking\.y.*0～1079/);
});

test("rejects invalid name correction mappings", () => {
  const valid = parseMuniConfig(validSource);
  assert.throws(() => validateMuniConfig({ ...valid, nameCorrections: { broken: 123 } }), /nameCorrections\.broken/);
});
