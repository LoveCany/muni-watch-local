import assert from "node:assert/strict";
import test from "node:test";
import { latestPositiveMovement, scoreAtRank } from "../lib/pace.ts";

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
