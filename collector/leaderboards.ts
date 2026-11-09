import type { LeaderboardId } from "./types.ts";

export const leaderboardNames: Record<LeaderboardId, string> = {
  total_pt: "累計Ptランキング", daily_pt: "デイリーPtランキング", poker_coin: "POKER COINランキング",
};

export function identifyLeaderboard(name: unknown, day: unknown) {
  const board = (Object.keys(leaderboardNames) as LeaderboardId[]).find(id => leaderboardNames[id] === name);
  if (!board || typeof day !== "number" || !Number.isSafeInteger(day) ||
      (board === "daily_pt" ? day < 1 || day > 366 : day !== 0)) throw new Error("Invalid leaderboard identity or period");
  return { board, rankingName: leaderboardNames[board], dayNumber: day };
}

export function parseLeaderboard(value: string | null): LeaderboardId {
  if (value === null) return "total_pt";
  if (Object.hasOwn(leaderboardNames, value)) return value as LeaderboardId;
  throw new Error("Unknown leaderboard");
}

export function boardTablePrefix(board: LeaderboardId, day: number) {
  identifyLeaderboard(leaderboardNames[board], day);
  return board === "daily_pt" ? `daily_pt_day_${day}_` : `${board}_`;
}
