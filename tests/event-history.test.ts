import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHistoryDatabase } from "../collector/history-db.ts";
import { createEventHistoryStore } from "../collector/event-history.ts";
import { assertScoreContinuity } from "../collector/score-validation.ts";

function capture(score: number, count = 20) {
  return { id: "synthetic-capture", capturedAt: new Date().toISOString(), entries: Array.from({ length: count }, (_, i) =>
    ({ rank: i + 1, name: "Synthetic player " + (i + 1), score: score - i })) };
}
test("event databases accept TOP20, preserve past files and isolate continuity baselines", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muni-events-"));
  const store = createEventHistoryStore(path.join(dir, "events"));
  try {
    const oldFile = path.join(dir, "past.sqlite");
    const old = createHistoryDatabase(oldFile); old.insert(capture(1000, 7)); old.close();
    const original = await readFile(oldFile);
    const first = store.select(101); first.database.insert(capture(1000));
    assert.equal(first.database.query().at(-1)?.entries.length, 20);
    assert.throws(() => assertScoreContinuity(capture(100).entries, first.database.query()), /スコア/);
    const second = store.select(102);
    assert.deepEqual(second.database.query(), []);
    assert.doesNotThrow(() => assertScoreContinuity(capture(100).entries, second.database.query()));
    second.database.insert(capture(100));
    assert.equal(store.select(101).database.query().at(-1)?.entries[0].score, 1000);
    assert.deepEqual(await readFile(oldFile), original);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
test("named board tables in one event database never overwrite each other", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muni-boards-"));
  let total: ReturnType<typeof createHistoryDatabase> | null = null;
  let other: ReturnType<typeof createHistoryDatabase> | null = null;
  try {
    const file = path.join(dir, "event.sqlite");
    total = createHistoryDatabase(file, { tablePrefix: "total_pt_", maxEntries: 20 });
    other = createHistoryDatabase(file, { tablePrefix: "synthetic_board_", maxEntries: 20 });
    total.insert(capture(1000)); other.insert(capture(100));
    assert.equal(total.query().at(-1)?.entries[0].score, 1000);
    assert.equal(other.query().at(-1)?.entries[0].score, 100);
    assert.throws(() => createHistoryDatabase(file, { tablePrefix: "unsafe;" }), /prefix/);
  } finally { other?.close(); total?.close(); await rm(dir, { recursive: true, force: true }); }
});
