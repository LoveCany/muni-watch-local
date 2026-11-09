import assert from "node:assert/strict";
import test from "node:test";
import { latestPositiveMovement, previousCaptureChange, scoreAtRank } from "../lib/pace.ts";

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

test("per-capture change compares the same rank only against the preceding poll", () => {
  const capture = (score: number, name: string) => ({ capturedAt: "2026-08-01T00:00:00Z", entries: [{ rank: 1, name, score }] });
  const history = [capture(100, "first"), capture(140, "renamed")];
  assert.equal(previousCaptureChange(history, 1), 40);
  history.push(capture(140, "renamed"));
  assert.equal(previousCaptureChange(history, 1), 0);
  history.push(capture(130, "replacement"));
  assert.equal(previousCaptureChange(history, 1), -10);
  assert.equal(previousCaptureChange(history.slice(0, 1), 1), null);
  assert.equal(previousCaptureChange(history, 2), null);
});
