import type { RuntimeRankingResult } from "./types.ts";

export async function captureBoards(actions: {
  capture(): Promise<RuntimeRankingResult>;
  next(): Promise<void>;
  save(result: RuntimeRankingResult): Promise<void>;
}) {
  const seen = new Set<string>();
  let eventId: number | undefined;
  for (let index = 0; index < 4; index++) {
    const result = await actions.capture();
    if (eventId !== undefined && result.eventId !== eventId) throw new Error("Event changed between leaderboards");
    eventId = result.eventId;
    if (seen.has(result.board)) {
      if (result.board !== "total_pt") throw new Error("Unexpected leaderboard carousel order");
      return;
    }
    if (index === 0 && result.board !== "total_pt") throw new Error("Refresh did not open the total Pt leaderboard");
    seen.add(result.board);
    await actions.save(result);
    await actions.next();
  }
  throw new Error("Leaderboard carousel did not return to total Pt");
}
