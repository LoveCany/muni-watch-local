import assert from "node:assert/strict";
import test from "node:test";
import { captureBoards } from "../collector/board-capture.ts";
import { identifyLeaderboard, parseLeaderboard } from "../collector/leaderboards.ts";
import type { LeaderboardId, RuntimeRankingResult } from "../collector/types.ts";

function result(board: LeaderboardId, eventId = 100): RuntimeRankingResult {
  const names = { total_pt: "累計Ptランキング", daily_pt: "デイリーPtランキング", poker_coin: "POKER COINランキング" };
  return { board, rankingName: names[board], dayNumber: board === "daily_pt" ? 2 : 0, eventId,
    capturedAt: "2026-01-01T00:00:00Z", entries: [] };
}

test("carousel collects each board once, returning to total and persisting before switching", async () => {
  const sequence: LeaderboardId[] = ["total_pt", "daily_pt", "poker_coin", "total_pt"];
  const actions: string[] = [];
  await captureBoards({
    capture: async () => result(sequence.shift()!),
    save: async r => { actions.push(r.board); }, next: async () => { actions.push("next"); },
  });
  assert.deepEqual(actions, ["total_pt", "next", "daily_pt", "next", "poker_coin", "next"]);
});

test("single-board events finish and changed events cannot mix data", async () => {
  let saved = 0;
  await captureBoards({ capture: async () => result("total_pt"), next: async () => {}, save: async () => { saved++; } });
  assert.equal(saved, 1);
  let reads = 0;
  await assert.rejects(captureBoards({
    capture: async () => result(reads++ ? "daily_pt" : "total_pt", reads === 1 ? 100 : 101),
    next: async () => {}, save: async () => {},
  }), /Event changed/);
  await assert.rejects(captureBoards({ capture: async () => result("daily_pt"), next: async () => {}, save: async () => {} }), /total Pt/);
});

test("failed board writes prevent switching away and board identity is bounded", async () => {
  let switched = false;
  await assert.rejects(captureBoards({ capture: async () => result("total_pt"),
    save: async () => { throw new Error("disk failed"); }, next: async () => { switched = true; },
  }), /disk failed/);
  assert.equal(switched, false);
  assert.equal(identifyLeaderboard("デイリーPtランキング", 6).board, "daily_pt");
  assert.throws(() => identifyLeaderboard("デイリーPtランキング", 0), /identity/);
  assert.throws(() => identifyLeaderboard("POKER COINランキング", 1), /identity/);
  assert.throws(() => parseLeaderboard("__proto__"), /Unknown/);
  assert.equal(parseLeaderboard(null), "total_pt");
});
