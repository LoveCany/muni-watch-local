import type { RankingEntry, RecognizedEntry } from "./types.ts";

export type SelectedScore = { score: number; confidence: number; variant: string };

function parseScore(text: unknown): number | null {
  const compact = String(text ?? "").normalize("NFKC").replace(/[,\s]/g, "");
  if (!/^\d{6,12}$/.test(compact)) return null;
  const score = Number(compact);
  return Number.isSafeInteger(score) && score > 0 ? score : null;
}

export function selectLeaderboardScores(recognizedEntries: Array<Pick<RecognizedEntry, "rank" | "scoreCandidates">>): SelectedScore[] {
  const candidateRows = recognizedEntries.map((entry) => {
    const deduplicated = new Map<number, SelectedScore>();
    for (const candidate of entry.scoreCandidates ?? []) {
      const score = parseScore(candidate.text);
      if (score == null) continue;
      const normalized = { score, confidence: Number(candidate.confidence) || 0, variant: candidate.variant ?? "unknown" };
      const previous = deduplicated.get(score);
      if (!previous || normalized.confidence > previous.confidence) deduplicated.set(score, normalized);
    }
    const candidates = [...deduplicated.values()].sort((left, right) => right.confidence - left.confidence);
    if (!candidates.length) throw new Error(`${entry.rank}位のスコア候補をPP-OCRから取得できませんでした`);
    return { rank: entry.rank, candidates };
  });

  let best: { selected: SelectedScore[]; confidence: number } | null = null;
  function visit(index: number, previousScore: number, selected: SelectedScore[], confidence: number) {
    if (index === candidateRows.length) {
      if (!best || confidence > best.confidence) best = { selected: [...selected], confidence };
      return;
    }
    for (const candidate of candidateRows[index].candidates) {
      if (candidate.score > previousScore) continue;
      selected.push(candidate);
      visit(index + 1, candidate.score, selected, confidence + candidate.confidence);
      selected.pop();
    }
  }
  visit(0, Number.POSITIVE_INFINITY, [], 0);
  if (!best) throw new Error("PP-OCRのスコア候補がランキング順と一致しません");
  return (best as { selected: SelectedScore[] }).selected;
}

export function assertScoreContinuity(entries: RankingEntry[], recentCaptures: Array<{ entries: RankingEntry[] }>): void {
  const latestByRank = new Map<number, number>();
  for (const capture of recentCaptures) {
    for (const entry of capture.entries) latestByRank.set(entry.rank, entry.score);
  }
  for (const entry of entries) {
    const previousScore = latestByRank.get(entry.rank);
    if (previousScore != null && entry.score < previousScore) {
      throw new Error(`${entry.rank}位のスコアが減少しています (${previousScore} → ${entry.score})`);
    }
  }
}
