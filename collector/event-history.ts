import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHistoryDatabase } from "./history-db.ts";

export function createEventHistoryStore(directory: string) {
  let eventId: number | null = null;
  let database: ReturnType<typeof createHistoryDatabase> | null = null;
  return {
    get current() { return database; },
    select(nextId: number) {
      if (!Number.isSafeInteger(nextId) || nextId <= 0) throw new Error("Invalid event history ID");
      if (nextId === eventId && database) return { database, changed: false };
      mkdirSync(directory, { recursive: true });
      const next = createHistoryDatabase(path.join(directory, nextId + ".sqlite"), { tablePrefix: "total_pt_", maxEntries: 20 });
      database?.close();
      database = next;
      eventId = nextId;
      return { database: next, changed: true };
    },
    close() { database?.close(); database = null; eventId = null; },
  };
}
