import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOcrName, stabilizeOcrName } from "../collector/name-normalization.ts";

const corrections = { テストプレイヤ一: "テストプレイヤー" };

test("compacts Japanese OCR spacing and applies configured corrections", () => {
  assert.equal(normalizeOcrName(" テスト プレイヤ 一\n", corrections), "テストプレイヤー");
});

test("keeps a known player name stable when their rank changes", () => {
  const history = [{
    capturedAt: "2026-08-03T11:56:21.985Z",
    entries: [{ rank: 4, name: "テストプレイヤー", score: 82453204 }],
  }];
  assert.equal(stabilizeOcrName("テストプレイヤ一", 82821212, history), "テストプレイヤー");
});

test("does not replace an unrelated newly observed player", () => {
  const history = [{
    capturedAt: "2026-08-03T11:56:21.985Z",
    entries: [{ rank: 4, name: "テストプレイヤー", score: 82453204 }],
  }];
  assert.equal(stabilizeOcrName("新規プレイヤー", 82821212, history), "新規プレイヤー");
});
