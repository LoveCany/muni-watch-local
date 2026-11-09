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

test("pace fitting follows ranks across nickname collisions and renames", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muni-collision-"));
  const database = createHistoryDatabase(path.join(dir, "history.sqlite"));
  try {
    for (let i = 0; i < 2; i++) database.insert({
      id: String(i), capturedAt: new Date(Date.now() - (2 - i) * 60000).toISOString(),
      entries: [
        { rank: 1, name: i ? "renamed" : "shared", score: 1000 + i * 20 },
        { rank: 2, name: "shared", score: 800 + i * 10 },
        { rank: 3, name: "unique", score: 600 + i * 10 },
      ],
    });
    const fitted = database.fitPaces();
    assert.deepEqual(fitted.slice(0, 2).map(row => row.rate), [1200, 600]);
    assert.equal(fitted[2].rate, 600);
    assert.equal(database.query().at(-1)?.entries.length, 3);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});
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

test("daily rollover and additional boards keep separate history and continuity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muni-days-"));
  const store = createEventHistoryStore(dir);
  try {
    store.select(101).database.insert(capture(1000));
    store.select(101, "daily_pt", 1).database.insert(capture(500));
    const day2 = store.select(101, "daily_pt", 2).database;
    assert.deepEqual(day2.query(), []);
    assert.doesNotThrow(() => assertScoreContinuity(capture(100).entries, day2.query()));
    day2.insert(capture(100));
    store.select(101, "poker_coin").database.insert(capture(700));
    assert.equal(store.select(101, "daily_pt", 1).database.query()[0].entries[0].score, 500);
    assert.equal(store.select(101).database.query()[0].entries[0].score, 1000);
    assert.equal(store.select(101, "poker_coin").database.query()[0].entries[0].score, 700);
    assert.throws(() => store.select(101, "daily_pt", 0), /identity/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
