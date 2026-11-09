export type PaceEntry = { rank: number; name: string; score: number };
export type PaceCapture = { capturedAt: string; entries: PaceEntry[] };

export function scoreChangeAgeMinutes(latestCapturedAt: string, changeCapturedAt: string) {
  const elapsedMs = new Date(latestCapturedAt).getTime() - new Date(changeCapturedAt).getTime();
  return Math.max(0, Math.round(elapsedMs / 60_000));
}

export function scoreChangeFreshness(ageMinutes: number) {
  if (ageMinutes === 0) return "now";
  if (ageMinutes <= 2) return "recent";
  if (ageMinutes <= 5) return "aging";
  return "stale";
}

export function catchUpMinutes(gap: number, leaderRate: number | null, pursuerRate: number | null) {
  if (gap <= 0 || leaderRate == null || pursuerRate == null) return null;
  const closingRate = pursuerRate - leaderRate;
  if (closingRate <= 0) return null;
  return Math.ceil(gap / closingRate * 60);
}

export function catchUpLabel(minutes: number | null) {
  if (minutes == null || !Number.isFinite(minutes)) return "--:--";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.floor(minutes % 60);
  return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}`;
}

export function latestPositiveMovement(history: PaceCapture[], entry: PaceEntry) {
  const playerSnapshots: Array<{ capturedAt: string; score: number }> = [];

  // A series represents the score at a rank, even when its occupant or nickname changes.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const rankedEntry = history[index].entries.find((item) => item.rank === entry.rank);
    if (!rankedEntry) continue;
    playerSnapshots.push({ capturedAt: history[index].capturedAt, score: rankedEntry.score });
  }

  playerSnapshots.reverse();

  // Collapse unchanged polls. The first timestamp at which each distinct score
  // appeared is the best available boundary for the real scoring interval.
  const scoreChanges: Array<{ capturedAt: string; score: number }> = [];
  for (const snapshot of playerSnapshots) {
    if (scoreChanges.at(-1)?.score !== snapshot.score) scoreChanges.push(snapshot);
  }

  for (let index = scoreChanges.length - 1; index > 0; index -= 1) {
    const current = scoreChanges[index];
    const previous = scoreChanges[index - 1];
    const delta = current.score - previous.score;
    const elapsedMs = new Date(current.capturedAt).getTime() - new Date(previous.capturedAt).getTime();
    if (delta <= 0 || elapsedMs <= 0) continue;
    return { delta, rate: Math.round(delta * 3_600_000 / elapsedMs), capturedAt: current.capturedAt };
  }

  return null;
}

export function scoreAtRank(capture: PaceCapture | undefined, rank: number) {
  return capture?.entries.find(entry => entry.rank === rank)?.score ?? null;
}

export function previousCaptureChange(history: PaceCapture[], rank: number) {
  const current = scoreAtRank(history.at(-1), rank);
  const previous = scoreAtRank(history.at(-2), rank);
  return current == null || previous == null ? null : current - previous;
}
