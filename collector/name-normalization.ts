import type { RankingEntry } from "./types.ts";

function japaneseCompact(value: string): string {
  return value.replace(
    /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])/gu,
    "$1",
  );
}

export function normalizeOcrName(raw: unknown, corrections: Record<string, string> = {}): string {
  const compact = japaneseCompact(String(raw ?? "").replace(/\s+/g, " ").trim());
  return corrections[compact] ?? compact;
}

function editDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

export function stabilizeOcrName(
  rawName: unknown,
  score: number,
  recentCaptures: Array<{ capturedAt: string; entries: RankingEntry[] }>,
  corrections: Record<string, string> = {},
): string {
  const name = normalizeOcrName(rawName, corrections);
  if (!name) return name;

  const latestByName = new Map<string, { score: number; capturedAt: string }>();
  for (const capture of recentCaptures) {
    for (const entry of capture.entries ?? []) {
      const knownName = normalizeOcrName(entry.name, corrections);
      if (knownName) latestByName.set(knownName, { score: Number(entry.score), capturedAt: capture.capturedAt });
    }
  }
  if (latestByName.has(name)) return name;

  const candidates: Array<{ name: string; distance: number; capturedAt: string }> = [];
  for (const [knownName, latest] of latestByName) {
    const distance = editDistance(name, knownName);
    if (distance !== 1) continue;
    const scoreGap = Number(score) - latest.score;
    const maximumGap = Math.max(1_000_000, Math.round(latest.score * 0.03));
    if (scoreGap < 0 || scoreGap > maximumGap) continue;
    candidates.push({ name: knownName, distance, capturedAt: latest.capturedAt });
  }
  candidates.sort((left, right) => left.distance - right.distance || right.capturedAt.localeCompare(left.capturedAt));
  return candidates[0]?.name ?? name;
}
