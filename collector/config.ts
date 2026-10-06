import { parseDocument, stringify } from "yaml";
import type { MuniConfig } from "./types.ts";

const TOP_LEVEL_KEYS = [
  "adbPath", "serial", "deviceName", "eventName", "leaderboard", "screen", "maxEntries",
  "intervalMinutes", "auto", "waitAfterBackMs", "waitAfterRankingMs",
  "waitAfterTop20Ms", "taps", "ocr", "nameCorrections", "captureMode",
] as const;
const TAP_KEYS = ["back", "ranking", "top20"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`設定ファイルが不正です: ${message}`);
}

function requireRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} はオブジェクトで指定してください`);
}

function requireKeys(value: Record<string, unknown>, expected: readonly string[], path: string, optional: readonly string[] = []) {
  const missing = expected.filter((key) => !(key in value) && !optional.includes(key));
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (missing.length) fail(`${path} に必須項目がありません: ${missing.join(", ")}`);
  if (unknown.length) fail(`${path} に未定義の項目があります: ${unknown.join(", ")}`);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail(`${path} は空でない文字列で指定してください`);
}

function requireInteger(value: unknown, path: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${path} は ${minimum}～${maximum} の整数で指定してください`);
  }
}

export function validateMuniConfig(value: unknown): MuniConfig {
  requireRecord(value, "ルート");
  requireKeys(value, TOP_LEVEL_KEYS, "ルート", ["captureMode"]);
  for (const key of ["adbPath", "serial", "deviceName", "eventName", "leaderboard"] as const) requireString(value[key], key);

  const screen = value.screen;
  requireRecord(screen, "screen");
  requireKeys(screen, ["width", "height"], "screen");
  requireInteger(screen.width, "screen.width", 320, 7680);
  requireInteger(screen.height, "screen.height", 320, 7680);

  const captureMode = value.captureMode === undefined ? "il2cpp" : value.captureMode;
  if (captureMode !== "ocr" && captureMode !== "il2cpp") fail("captureMode must be ocr or il2cpp");
  requireInteger(value.maxEntries, "maxEntries", captureMode === "il2cpp" ? 20 : 1, captureMode === "il2cpp" ? 20 : 7);
  requireInteger(value.intervalMinutes, "intervalMinutes", 1, 60);
  if (typeof value.auto !== "boolean") fail("auto は true または false で指定してください");
  for (const key of ["waitAfterBackMs", "waitAfterRankingMs", "waitAfterTop20Ms"] as const) {
    requireInteger(value[key], key, 0, 60_000);
  }

  const ocr = value.ocr;
  requireRecord(ocr, "ocr");
  requireKeys(ocr, ["pythonPath", "modelName", "modelDirectory", "device", "batchSize", "timeoutMs"], "ocr");
  for (const key of ["pythonPath", "modelName", "modelDirectory", "device"] as const) requireString(ocr[key], `ocr.${key}`);
  const ocrDevice = ocr.device;
  requireString(ocrDevice, "ocr.device");
  if (!ocrDevice.startsWith("gpu")) fail("ocr.device は gpu または gpu:0 の形式で指定してください");
  requireInteger(ocr.batchSize, "ocr.batchSize", 1, 64);
  requireInteger(ocr.timeoutMs, "ocr.timeoutMs", 5_000, 300_000);

  const taps = value.taps;
  requireRecord(taps, "taps");
  requireKeys(taps, TAP_KEYS, "taps");
  for (const key of TAP_KEYS) {
    const tap = taps[key];
    requireRecord(tap, `taps.${key}`);
    requireKeys(tap, ["x", "y"], `taps.${key}`);
    requireInteger(tap.x, `taps.${key}.x`, 0, screen.width - 1);
    requireInteger(tap.y, `taps.${key}.y`, 0, screen.height - 1);
  }

  const nameCorrections = value.nameCorrections;
  requireRecord(nameCorrections, "nameCorrections");
  for (const [source, replacement] of Object.entries(nameCorrections)) {
    requireString(source, "nameCorrections のキー");
    requireString(replacement, `nameCorrections.${source}`);
  }
  return { ...value, captureMode } as MuniConfig;
}

export function parseMuniConfig(source: string): MuniConfig {
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length) {
    throw new Error(`設定YAMLを解析できません: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return validateMuniConfig(document.toJS());
}

export function serializeMuniConfig(config: MuniConfig): string {
  validateMuniConfig(config);
  return stringify(config, { indent: 2, lineWidth: 0 });
}
