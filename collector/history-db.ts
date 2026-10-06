import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Capture, RankingEntry } from "./types.ts";

type QueryOptions = { hours?: number; maxPoints?: number };
type PaceResult = { rank: number; name: string; rate: number | null; samples: number; from?: string; to?: string };
type HistoryRow = Record<string, SQLInputValue> & {
  id: string;
  captured_at: string;
  rank: number;
  name: string;
  score: number;
  confidence: number | null;
};

function downsampleCaptures(captures: Capture[], maxPoints: number): Capture[] {
  if (captures.length <= maxPoints) return captures;
  const sampled: Capture[] = [];
  let previousIndex = -1;
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round(index * (captures.length - 1) / (maxPoints - 1));
    if (sourceIndex !== previousIndex) sampled.push(captures[sourceIndex]);
    previousIndex = sourceIndex;
  }
  return sampled;
}

export function createHistoryDatabase(filename: string, { tablePrefix = "", maxEntries = 7 }: { tablePrefix?: string; maxEntries?: 7 | 20 } = {}) {
  if (maxEntries !== 7 && maxEntries !== 20) throw new Error("Invalid history entry limit");
  if (tablePrefix && !/^[a-z][a-z0-9_]{0,63}_$/.test(tablePrefix)) throw new Error("Invalid history table prefix");
  function scopedSql(source: string) {
    return source.replace(/\b(captures|ranking_entries(?:_v2)?|idx_captures_captured_at_ms)\b/g, name => tablePrefix + name);
  }
  const database = new DatabaseSync(filename);
  const executeSql = (source: string) => database.exec(scopedSql(source));
  const prepareSql = (source: string) => database.prepare(scopedSql(source));
  executeSql("PRAGMA foreign_keys = ON");
  executeSql("PRAGMA journal_mode = WAL");
  executeSql(`CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, captured_at_ms INTEGER NOT NULL)`);
  executeSql(`
    CREATE TABLE IF NOT EXISTS ranking_entries (
      capture_id TEXT NOT NULL,
      rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND ${maxEntries}),
      name TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 0),
      confidence REAL,
      PRIMARY KEY (capture_id, rank),
      FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
    )
  `);
  const schemaRow = prepareSql("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ranking_entries'").get();
  const rankingSchema = typeof schemaRow?.sql === "string" ? schemaRow.sql : "";
  if (/BETWEEN\s+1\s+AND\s+3\b/i.test(rankingSchema)) {
    executeSql("PRAGMA foreign_keys = OFF");
    executeSql("BEGIN IMMEDIATE");
    try {
      executeSql(`
        CREATE TABLE ranking_entries_v2 (
          capture_id TEXT NOT NULL,
          rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND ${maxEntries}),
          name TEXT NOT NULL,
          score INTEGER NOT NULL CHECK (score >= 0),
          confidence REAL,
          PRIMARY KEY (capture_id, rank),
          FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
        );
        INSERT INTO ranking_entries_v2 SELECT capture_id, rank, name, score, confidence FROM ranking_entries;
        DROP TABLE ranking_entries;
        ALTER TABLE ranking_entries_v2 RENAME TO ranking_entries;
      `);
      executeSql("COMMIT");
    } catch (error) {
      executeSql("ROLLBACK");
      throw error;
    } finally {
      executeSql("PRAGMA foreign_keys = ON");
    }
  }
  executeSql("CREATE INDEX IF NOT EXISTS idx_captures_captured_at_ms ON captures(captured_at_ms)");
  executeSql("PRAGMA optimize");

  const insertCapture = prepareSql("INSERT OR IGNORE INTO captures (id, captured_at, captured_at_ms) VALUES (?, ?, ?)");
  const insertEntry = prepareSql("INSERT OR REPLACE INTO ranking_entries (capture_id, rank, name, score, confidence) VALUES (?, ?, ?, ?, ?)");
  const selectHistory = prepareSql(`
    SELECT c.id, c.captured_at, e.rank, e.name, e.score, e.confidence
    FROM captures c JOIN ranking_entries e ON e.capture_id = c.id
    WHERE c.captured_at_ms >= ? ORDER BY c.captured_at_ms ASC, e.rank ASC
  `);

  function insert(capture: Capture): void {
    executeSql("BEGIN IMMEDIATE");
    try {
      insertCapture.run(capture.id, capture.capturedAt, new Date(capture.capturedAt).getTime());
      for (const entry of capture.entries) insertEntry.run(capture.id, entry.rank, entry.name, entry.score, entry.confidence ?? null);
      executeSql("COMMIT");
    } catch (error) {
      executeSql("ROLLBACK");
      throw error;
    }
  }

  function backfill(captures: Capture[]): void {
    for (const capture of captures) insert(capture);
  }

  function query({ hours = 24, maxPoints = 240 }: QueryOptions = {}): Capture[] {
    const rows = selectHistory.all(Date.now() - hours * 3_600_000) as HistoryRow[];
    const captures: Capture[] = [];
    let current: Capture | null = null;
    for (const row of rows) {
      if (!current || current.id !== row.id) {
        current = { id: row.id, capturedAt: row.captured_at, entries: [] };
        captures.push(current);
      }
      const entry: RankingEntry = { rank: Number(row.rank), name: String(row.name), score: Number(row.score) };
      if (row.confidence != null) entry.confidence = Number(row.confidence);
      current.entries.push(entry);
    }
    return downsampleCaptures(captures, maxPoints);
  }

  function fitPaces({ hours = 1 }: Pick<QueryOptions, "hours"> = {}): PaceResult[] {
    const captures = query({ hours, maxPoints: 10_000 });
    const latestEntries = captures.at(-1)?.entries ?? [];
    return latestEntries.map((latestEntry) => {
      const samples = captures.flatMap((capture) => {
        const entry = capture.entries.find((item) => item.name === latestEntry.name);
        return entry ? [{ time: new Date(capture.capturedAt).getTime(), score: entry.score }] : [];
      });
      if (samples.length < 2) return { rank: latestEntry.rank, name: latestEntry.name, rate: null, samples: samples.length };
      const origin = samples[0].time;
      const points = samples.map((sample) => ({ x: sample.time - origin, y: sample.score }));
      const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const numerator = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
      const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
      const rate = denominator <= 0 ? null : Math.max(0, Math.round(numerator / denominator * 3_600_000));
      return {
        rank: latestEntry.rank, name: latestEntry.name, rate, samples: samples.length,
        from: new Date(samples[0].time).toISOString(), to: new Date(samples.at(-1)!.time).toISOString(),
      };
    });
  }

  return { insert, backfill, query, fitPaces, close: () => database.close() };
}
