import { mkdirSync } from "node:fs";
import path from "node:path";
import type { LeaderboardId } from "./types.ts";
import { boardTablePrefix } from "./leaderboards.ts";
import { createHistoryDatabase } from "./history-db.ts";

export function createEventHistoryStore(directory: string) {
  let eventId: number | null = null;
  const databases = new Map<string, ReturnType<typeof createHistoryDatabase>>();
  return {
    get current() { return databases.get("total_pt_") ?? null; },
    select(nextId: number, board: LeaderboardId = "total_pt", dayNumber = 0) {
      if (!Number.isSafeInteger(nextId) || nextId <= 0) throw new Error("Invalid event history ID");
      const prefix = boardTablePrefix(board, dayNumber);
      const changed = nextId !== eventId;
      if (changed) {
        for (const database of databases.values()) database.close();
        databases.clear();
        eventId = nextId;
      }
      let database = databases.get(prefix);
      if (!database) {
        mkdirSync(directory, { recursive: true });
        database = createHistoryDatabase(path.join(directory, nextId + ".sqlite"), { tablePrefix: prefix, maxEntries: 20 });
        databases.set(prefix, database);
      }
      return { database, changed };
    },
    close() {
      for (const database of databases.values()) database.close();
      databases.clear(); eventId = null;
    },
  };
}
