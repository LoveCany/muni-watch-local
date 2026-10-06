import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHistoryDatabase } from "../collector/history-db.ts";
import { parseMuniConfig } from "../collector/config.ts";
import { catchUpLabel, catchUpMinutes, latestPositiveMovement, scoreChangeAgeMinutes, scoreChangeFreshness } from "../lib/pace.ts";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the local ranking monitor shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>むに Watch — MuMu ランキング監視<\/title>/i);
  assert.match(html, /トップ.*・リアルタイム/);
  assert.match(html, /順位 \/ プレイヤー/);
  assert.match(html, /総ポイント推移/);
  assert.match(html, /収集サービス停止中/);
  assert.match(html, /ランキング → TOP20/);
  assert.doesNotMatch(html, /MuMuスクリーンショット/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("uses TypeScript for the Node.js runtime and tests", async () => {
  const directories = ["collector", "scripts", "tests"];
  for (const directory of directories) {
    const files = await readdir(new URL(`../${directory}/`, import.meta.url));
    const nodeSources = files.filter((file) => /\.(?:[cm]?js|ts)$/.test(file));
    assert.ok(nodeSources.length > 0, `${directory} should contain source files`);
    assert.deepEqual(nodeSources.filter((file) => !file.endsWith(".ts")), []);
  }
});

test("ships the collector and one-command local launcher", async () => {
  const [page, styles, layout, pace, collector, gateway, publicLauncher, configText, packageText, ignoreText] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace.ts", import.meta.url), "utf8"),
    readFile(new URL("../collector/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/public-gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/public.ts", import.meta.url), "utf8"),
    readFile(new URL("../config/muni.example.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  const config = parseMuniConfig(configText);
  const packageJson = JSON.parse(packageText);

  assert.equal(config.serial, "127.0.0.1:16384");
  assert.equal(config.deviceName, "Android Device");
  assert.deepEqual(config.screen, { width: 1920, height: 1080 });
  assert.equal(config.maxEntries, 20);
  assert.deepEqual(config.taps.back, { x: 75, y: 60 });
  assert.deepEqual(config.taps.ranking, { x: 655, y: 400 });
  assert.deepEqual(config.taps.top20, { x: 960, y: 280 });
  assert.equal(packageJson.scripts.local, "tsx scripts/local.ts");
  assert.equal(packageJson.scripts.collector, "tsx collector/server.ts");
  assert.equal(packageJson.scripts.gateway, "tsx scripts/public-gateway.ts");
  assert.equal(packageJson.scripts.public, "npm run build && tsx scripts/public.ts");
  assert.equal(packageJson.scripts["public:update"], "npm run build");
  assert.equal(packageJson.dependencies["tesseract.js"], undefined);
  assert.doesNotMatch(packageText, /react-loading-skeleton/);
  assert.match(page, /api\/capture/);
  assert.match(page, /api\/settings/);
  assert.match(layout, /むに Watch/);
  assert.match(collector, /createPpOcrClient/);
  assert.match(collector, /Android Device|config\.deviceName/);
  assert.match(collector, /selectLeaderboardScores/);
  assert.match(collector, /screencap/);
  assert.match(collector, /refreshTop20/);
  assert.match(collector, /database\.insert/);
  assert.match(collector, /\/api\/history/);
  assert.match(page, /公開ページ・閲覧専用/);
  assert.match(page, /latestPositiveMovement/);
  assert.match(page, /<table className="ranking-table">/);
  assert.match(page, /ScoreTrendChart/);
  assert.match(page, /onPointerMove/);
  assert.match(page, /chart-tooltip/);
  assert.match(page, /分前/);
  assert.match(page, /freshness-/);
  assert.match(page, /\[1, 6, 24, 168\]/);
  assert.match(page, /api\/history\?hours=/);
  assert.match(page, /api\/pace/);
  assert.match(page, /追いつかれるまで/);
  assert.match(page, /nf\.format\(gap\)/);
  assert.doesNotMatch(page, /entry\.confidence/);
  assert.doesNotMatch(page, /グラフにポインターを重ねると詳細を表示/);
  assert.doesNotMatch(page, /DB · 直近1時間から算出/);
  assert.doesNotMatch(page, /下位からの追い上げ予測/);
  assert.match(page, /canControl && <section className="lower-grid">/);
  assert.match(page, /canControl && <section className="source-strip">/);
  assert.doesNotMatch(page, /playerEntry\.score - baseline|窗口起点 = 0/);
  assert.match(page, /#d5960f.*#2168e8.*#d55374/);
  assert.match(styles, /ranking-table-wrap/);
  assert.match(styles, /chart-canvas-wrap/);
  assert.match(styles, /rank-identity/);
  assert.match(pace, /scoreChanges/);
  assert.match(pace, /delta \* 3_600_000 \/ elapsedMs/);
  assert.match(gateway, /Public access is read-only/);
  assert.match(gateway, /new Set\(\["GET", "HEAD"\]\)/);
  assert.match(gateway, /"\/api\/state", "\/api\/history", "\/api\/pace"/);
  assert.doesNotMatch(gateway, /url\.startsWith\("\/latest\.png"\)/);
  assert.match(gateway, /headers\.origin = target\.origin/);
  assert.match(gateway, /normalizeOrigin: !collectorRequest/);
  assert.match(gateway, /dist", "client/);
  assert.match(gateway, /serveBuiltAsset/);
  assert.match(publicLauncher, /cloudflared\.exe/);
  assert.match(publicLauncher, /"start"/);
  assert.match(publicLauncher, /publicFrontendPort = "3003"/);
  assert.match(publicLauncher, /MUNI_FRONTEND_ORIGIN/);
  assert.match(publicLauncher, /watchFile\(serverEntry/);
  assert.match(publicLauncher, /public frontend reloaded; tunnel URL unchanged/);
  assert.match(publicLauncher, /quick-tunnel\.yml/);
  assert.match(publicLauncher, /"--protocol", "http2"/);
  assert.match(ignoreText, /\/config\/\*\.yml/);
  assert.match(ignoreText, /\/data\/\*\*/);
  assert.match(ignoreText, /work-\*\.log/);
});

test("persists and downsamples long-term captures in local SQLite", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "muni-watch-history-"));
  const database = createHistoryDatabase(join(directory, "history.sqlite"));
  context.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const now = Date.now();
  const captures = Array.from({ length: 90 }, (_, index) => ({
    id: `capture-${index}`,
    capturedAt: new Date(now - (89 - index) * 60_000).toISOString(),
    entries: [1, 2, 3, 4, 5, 6, 7].map((rank) => ({ rank, name: `player-${rank}`, score: rank * 1_000_000 + index * rank * 100 })),
  }));
  database.backfill(captures);
  const history = database.query({ hours: 2, maxPoints: 40 });
  assert.equal(history.length, 40);
  assert.equal(history[0].id, "capture-0");
  assert.equal(history.at(-1)!.id, "capture-89");
  assert.deepEqual(history.at(-1)!.entries.map((entry) => entry.rank), [1, 2, 3, 4, 5, 6, 7]);
  const fitted = database.fitPaces({ hours: 1 });
  assert.deepEqual(fitted.map((player) => player.rate), [6000, 12000, 18000, 24000, 30000, 36000, 42000]);
});

test("calculates pace between distinct score uploads instead of assuming one minute", () => {
  const history = [
    { capturedAt: "2026-08-01T00:00:00.000Z", entries: [{ rank: 1, name: "player", score: 100 }] },
    { capturedAt: "2026-08-01T00:01:00.000Z", entries: [{ rank: 1, name: "player", score: 100 }] },
    { capturedAt: "2026-08-01T00:02:00.000Z", entries: [{ rank: 1, name: "player", score: 100 }] },
    { capturedAt: "2026-08-01T00:03:00.000Z", entries: [{ rank: 1, name: "player", score: 160 }] },
    { capturedAt: "2026-08-01T00:04:00.000Z", entries: [{ rank: 1, name: "player", score: 160 }] },
  ];

  assert.deepEqual(latestPositiveMovement(history, history.at(-1)!.entries[0]), { delta: 60, rate: 1200, capturedAt: "2026-08-01T00:03:00.000Z" });
  assert.equal(scoreChangeAgeMinutes(history.at(-1)!.capturedAt, "2026-08-01T00:03:00.000Z"), 1);
  assert.equal(scoreChangeFreshness(0), "now");
  assert.equal(scoreChangeFreshness(2), "recent");
  assert.equal(scoreChangeFreshness(4), "aging");
  assert.equal(scoreChangeFreshness(8), "stale");
  assert.equal(catchUpMinutes(60_000, 100_000, 160_000), 60);
  assert.equal(catchUpLabel(60), "01:00");
  assert.equal(catchUpLabel(61), "01:01");
  assert.equal(catchUpLabel(2_460), "41:00");
  assert.equal(catchUpMinutes(60_000, 160_000, 100_000), null);
  assert.equal(catchUpLabel(null), "--:--");

  history.push({ capturedAt: "2026-08-01T00:06:00.000Z", entries: [{ rank: 1, name: "player", score: 190 }] });
  assert.deepEqual(latestPositiveMovement(history, history.at(-1)!.entries[0]), { delta: 30, rate: 600, capturedAt: "2026-08-01T00:06:00.000Z" });
  assert.equal(scoreChangeAgeMinutes(history.at(-1)!.capturedAt, "2026-08-01T00:06:00.000Z"), 0);
});
