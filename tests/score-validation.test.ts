import assert from "node:assert/strict";
import test from "node:test";
import { assertScoreContinuity, selectLeaderboardScores } from "../collector/score-validation.ts";

test("selects the highest-confidence score combination that preserves leaderboard order", () => {
  const selected = selectLeaderboardScores([
    { rank: 1, scoreCandidates: [{ text: "200,000,000", confidence: 0.99, variant: "original" }] },
    { rank: 2, scoreCandidates: [{ text: "115000000", confidence: 0.99, variant: "original" }] },
    { rank: 3, scoreCandidates: [
      { text: "107450421", confidence: 0.999, variant: "original" },
      { text: "707450421", confidence: 1, variant: "contrast" },
    ] },
    { rank: 4, scoreCandidates: [{ text: "102909107", confidence: 0.99, variant: "original" }] },
  ]);
  assert.deepEqual(selected.map((candidate) => candidate.score), [200000000, 115000000, 107450421, 102909107]);
});

test("rejects score candidates that cannot form descending leaderboard order", () => {
  assert.throws(() => selectLeaderboardScores([
    { rank: 1, scoreCandidates: [{ text: "100000000", confidence: 1 }] },
    { rank: 2, scoreCandidates: [{ text: "200000000", confidence: 1 }] },
  ]), /ランキング順/);
});

test("rejects a score decrease for the same stabilized player", () => {
  const history = [{ entries: [{ rank: 3, name: "player", score: 1000 }] }];
  assert.throws(() => assertScoreContinuity([{ rank: 3, name: "player", score: 999 }], history), /スコアが減少/);
  assert.doesNotThrow(() => assertScoreContinuity([{ rank: 3, name: "player", score: 1001 }], history));
});

test("does not treat two current players sharing a nickname as one player", () => {
  const history = [{ entries: [{ rank: 1, name: "shared", score: 1000 }] }];
  assert.doesNotThrow(() => assertScoreContinuity([
    { rank: 1, name: "shared", score: 1010 },
    { rank: 2, name: "shared", score: 800 },
  ], history));
});

test("does not use an ambiguous historical nickname after one player leaves", () => {
  const history = [{ entries: [
    { rank: 1, name: "shared", score: 1000 },
    { rank: 2, name: "shared", score: 800 },
  ] }];
  assert.doesNotThrow(() => assertScoreContinuity([{ rank: 1, name: "shared", score: 790 }], history));
  assert.throws(() => assertScoreContinuity([{ rank: 1, name: "unique", score: 9 }], [
    ...history, { entries: [{ rank: 1, name: "unique", score: 10 }] },
  ]), /スコアが減少/);
});
