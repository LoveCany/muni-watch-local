import assert from "node:assert/strict";
import test from "node:test";
import { latestPositiveMovement, scoreAtRank, scoreChangeAgeMinutes, scoreChangeFreshness } from "../lib/pace.ts";

test("rank series and movement continue across renames and changes in occupant", () => {
  const history = [
    { capturedAt: "2026-08-01T00:00:00Z", entries: [
      { rank: 1, name: "first", score: 100 }, { rank: 2, name: "second", score: 80 },
    ] },
    { capturedAt: "2026-08-01T00:01:00Z", entries: [
      { rank: 1, name: "second", score: 120 }, { rank: 2, name: "renamed", score: 110 },
    ] },
  ];
  assert.deepEqual(history.map(capture => scoreAtRank(capture, 1)), [100, 120]);
  assert.deepEqual(history.map(capture => scoreAtRank(capture, 2)), [80, 110]);
  assert.equal(scoreAtRank(history[0], 3), null);
  assert.deepEqual(latestPositiveMovement(history, history[1].entries[0]), {
    delta: 20, rate: 1200, capturedAt: history[1].capturedAt,
  });
  assert.deepEqual(latestPositiveMovement(history, history[1].entries[1]), {
    delta: 30, rate: 1800, capturedAt: history[1].capturedAt,
  });
});

test("unchanged polls retain the last increase and age its timestamp", () => {
  const capture = (minute: string, score: number) => ({
    capturedAt: `2026-08-01T00:${minute}:00Z`, entries: [{ rank: 1, name: "Synthetic player", score }],
  });
  const history = [capture("00", 100), capture("01", 140), capture("02", 140), capture("07", 140)];
  const movement = latestPositiveMovement(history, history.at(-1)!.entries[0]);
  assert.equal(movement?.delta, 40);
  assert.equal(movement?.capturedAt, history[1].capturedAt);
  const age = scoreChangeAgeMinutes(history.at(-1)!.capturedAt, movement!.capturedAt);
  assert.equal(age, 6);
  assert.equal(scoreChangeFreshness(age), "stale");
  assert.equal(latestPositiveMovement([history[0]], history[0].entries[0]), null);
});
