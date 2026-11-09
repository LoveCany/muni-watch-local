import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { isRankingImage, isTop20Image, refreshTop20 } from "./ranking-refresh.ts";
import { captureBoards } from "./board-capture.ts";
import { parseLeaderboard } from "./leaderboards.ts";
import { createHistoryDatabase } from "./history-db.ts";
import { createEventHistoryStore } from "./event-history.ts";
import { parseMuniConfig, serializeMuniConfig } from "./config.ts";
import { normalizeOcrName, stabilizeOcrName } from "./name-normalization.ts";
import { createPpOcrClient } from "./ppocr-client.ts";
import { createIl2CppClient } from "./il2cpp-client.ts";
import { assertScoreContinuity, selectLeaderboardScores } from "./score-validation.ts";
import { createServiceDiagnostics, recordProcessLifecycle, runBackgroundCapture } from "./service-diagnostics.ts";
import type { Capture, CollectorState, MuniConfig, OcrRow, RankingEntry, RuntimeRankingResult, LeaderboardId } from "./types.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = path.join(ROOT, "config", "muni.yml");
const SCREENSHOT_FILE = path.join(ROOT, "data", "latest.png");
const HISTORY_DB_FILE = path.join(ROOT, "data", "muni-watch.sqlite");
const REMOTE_SCREENSHOT = "/sdcard/muni-watch-latest.png";
const PORT = 4317;
const lifecycle = createServiceDiagnostics(ROOT, "collector");
recordProcessLifecycle(lifecycle);

const rows: OcrRow[] = [
  { rank: 1, name: { left: 438, top: 235, width: 285, height: 36 }, score: { left: 960, top: 304, width: 180, height: 36 } },
  { rank: 2, name: { left: 438, top: 372, width: 285, height: 36 }, score: { left: 960, top: 440, width: 180, height: 36 } },
  { rank: 3, name: { left: 438, top: 508, width: 285, height: 36 }, score: { left: 960, top: 576, width: 180, height: 36 } },
  { rank: 4, name: { left: 438, top: 645, width: 285, height: 36 }, score: { left: 960, top: 713, width: 180, height: 36 } },
  { rank: 5, name: { left: 438, top: 781, width: 285, height: 36 }, score: { left: 960, top: 849, width: 180, height: 36 } },
  { rank: 6, name: { left: 438, top: 918, width: 285, height: 36 }, score: { left: 960, top: 986, width: 180, height: 36 } },
  { rank: 7, name: { left: 438, top: 1054, width: 285, height: 36 }, score: { left: 960, top: 1122, width: 180, height: 36 } },
];

await mkdir(path.join(ROOT, "data"), { recursive: true });
let config: MuniConfig;
try {
  config = parseMuniConfig(await readFile(CONFIG_FILE, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("config/muni.yml was not found. Copy config/muni.example.yml and customize it before starting.");
  }
  throw error;
}
const STATE_FILE = path.join(ROOT, "data", config.captureMode === "il2cpp" ? "il2cpp-state.json" : "state.json");
const defaultState: CollectorState = {
  status: "booting", lastUpdated: null, lastError: null, history: [],
  mumu: { name: config.deviceName, connected: false, screen: "unknown" }, ocr: null,
};
let state: CollectorState;
try {
  state = JSON.parse(await readFile(STATE_FILE, "utf8")) as CollectorState;
  state.mumu.name = config.deviceName;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  state = defaultState;
}
const eventHistory = createEventHistoryStore(path.join(ROOT, "data", "events"));
const legacyHistory = config.captureMode === "il2cpp" ? null : createHistoryDatabase(HISTORY_DB_FILE);
legacyHistory?.backfill(state.history);
if (config.captureMode === "il2cpp" && state.eventId) eventHistory.select(state.eventId);
function currentHistory(board: LeaderboardId = "total_pt") {
  if (board === "total_pt") return legacyHistory ?? eventHistory.current;
  const saved = state.boards?.[board];
  return saved && state.eventId ? eventHistory.select(state.eventId, board, saved.dayNumber).database : null;
}
const ocrClient = createPpOcrClient({ root: ROOT, config: config.ocr });
const runtimeClient = createIl2CppClient(ROOT, config);
let capturePromise: Promise<ReturnType<typeof publicState>> | null = null;
let intervalHandle: NodeJS.Timeout | null = null;
let shuttingDown = false;

function sleep(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }

async function adb(args: string[], timeout = 15000) {
  return execFileAsync(config.adbPath, args, { cwd: ROOT, timeout, windowsHide: true });
}

async function connectMuMu() {
  await adb(["connect", config.serial], 10000);
  const { stdout } = await adb(["-s", config.serial, "get-state"], 10000);
  if (!stdout.toLowerCase().includes("device")) throw new Error("MuMuのADBに接続できません");
  state.mumu.connected = true;
}

async function takeScreenshot() {
  await adb(["-s", config.serial, "shell", "screencap", "-p", REMOTE_SCREENSHOT], 15000);
  await adb(["-s", config.serial, "pull", REMOTE_SCREENSHOT, SCREENSHOT_FILE], 15000);
}

async function ensureTop20() {
  await refreshTop20(config, {
    back: config.captureMode === "il2cpp" ? async () => { await adb(["-s", config.serial, "shell", "input", "keyevent", "4"]); } : undefined,
    screenshot: takeScreenshot,
    isRanking: () => isRankingImage(SCREENSHOT_FILE, config.screen),
    isTop20: () => isTop20Image(SCREENSHOT_FILE, config.screen),
    tap: async ({ x, y }) => { await adb(["-s", config.serial, "shell", "input", "tap", String(x), String(y)]); },
    wait: sleep,
  });
}

function cleanName(raw: unknown) {
  return normalizeOcrName(raw, config.nameCorrections);
}

async function readEntries() {
  const previousEntries = state.history.at(-1)?.entries ?? [];
  const activeRows = rows.slice(0, config.maxEntries);
  const recognition = await ocrClient.recognize({ imagePath: SCREENSHOT_FILE, rows: activeRows });
  const selectedScores = selectLeaderboardScores(recognition.entries);
  const entries: RankingEntry[] = recognition.entries.map((recognized, index) => {
    let name = cleanName(recognized.name.text);
    if (!name) name = previousEntries.find((entry) => entry.rank === recognized.rank)?.name ?? `Unknown #${recognized.rank}`;
    const score = selectedScores[index].score;
    return {
      rank: recognized.rank,
      name: stabilizeOcrName(name, score, state.history.slice(-288), config.nameCorrections),
      score,
      confidence: Math.round((recognized.name.confidence ?? 0) * 100),
    };
  });
  assertScoreContinuity(entries, state.history.slice(-288));
  state.ocr = {
    engine: recognition.engine.engine,
    model: recognition.engine.model,
    device: recognition.engine.device,
    gpu: recognition.engine.gpu,
  };
  return entries;
}

async function saveBoard(result: RuntimeRankingResult) {
  if (state.eventId !== result.eventId) {
    state.boards = {};
    state.history = [];
    state.lastUpdated = null;
  }
  const { database } = eventHistory.select(result.eventId, result.board, result.dayNumber);
  state.eventId = result.eventId;
  state.boards ??= {};
  let board = state.boards[result.board];
  if (!board || board.dayNumber !== result.dayNumber) {
    const history = database.query({ hours: 48, maxPoints: 288 });
    board = { name: result.rankingName, dayNumber: result.dayNumber, history, lastUpdated: history.at(-1)?.capturedAt ?? null };
  }
  if (result.board !== "poker_coin") assertScoreContinuity(result.entries, board.history);
  const capture: Capture = { id: String(Date.now()), capturedAt: result.capturedAt, entries: result.entries };
  database.insert(capture);
  board.history = [...board.history, capture].slice(-288);
  board.lastUpdated = result.capturedAt;
  state.boards[result.board] = board;
  if (result.board === "total_pt") {
    state.history = board.history;
    state.lastUpdated = board.lastUpdated;
  }
  state.ocr = { engine: "IL2CPP", model: "EventRankingData", device: "MuMu", gpu: "unused" };
  await persist();
}

async function nextBoard() {
  if (config.screen.width !== 1920 || config.screen.height !== 1080)
    throw new Error("Multi-board collection requires the verified 1920 x 1080 layout");
  await adb(["-s", config.serial, "shell", "input", "tap", "1850", "650"]);
  await sleep(1000);
  for (let attempt = 0; attempt < 20; attempt++) {
    await adb(["-s", config.serial, "shell", "input", "tap", String(config.taps.top20.x), String(config.taps.top20.y)]);
    await sleep(Math.max(500, config.waitAfterTop20Ms));
    await takeScreenshot();
    if (await isTop20Image(SCREENSHOT_FILE, config.screen)) return;
  }
  throw new Error("Next leaderboard TOP20 did not load in time");
}

function publicState() {
  return {
    ...state,
    eventId: undefined,
    config: { intervalMinutes: config.intervalMinutes, auto: config.auto, eventName: config.eventName, leaderboard: config.leaderboard, maxEntries: config.maxEntries },
  };
}

async function persist() {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(CONFIG_FILE, serializeMuniConfig(config), "utf8");
}

async function runCapture() {
  if (shuttingDown) throw new Error("Collector is shutting down");
  if (capturePromise) return capturePromise;
  capturePromise = (async () => {
    state.status = "capturing";
    state.lastError = null;
    await persist();
    try {
      await connectMuMu();
      await ensureTop20();
      if (config.captureMode === "il2cpp") {
        await captureBoards({ capture: () => runtimeClient.capture(), next: nextBoard, save: saveBoard });
      } else {
        const entries = await readEntries();
        const capturedAt = new Date().toISOString();
        const capture: Capture = { id: String(Date.now()), capturedAt, entries };
        const database = currentHistory();
        if (!database) throw new Error("Current event history is not initialized");
        database.insert(capture);
        state.history = [...state.history, capture].slice(-288);
        state.lastUpdated = capturedAt;
      }
      state.status = "idle";
      state.mumu.screen = "TOP20";
    } catch (error) {
      state.status = "error";
      state.mumu.connected = false;
      state.lastError = error instanceof Error ? error.message : String(error);
    }
    await persist();
    return publicState();
  })().finally(() => { capturePromise = null; });
  return capturePromise;
}

function schedule() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  if (config.auto && !shuttingDown) intervalHandle = setInterval(() => void backgroundCapture(), config.intervalMinutes * 60_000);
}

function backgroundCapture() {
  return runBackgroundCapture(runCapture, error => {
    state.status = "error";
    state.lastError = "Collector background operation failed; see local service diagnostics";
    const code = (error as NodeJS.ErrnoException)?.code;
    lifecycle("background_capture_failed", { errorCode: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined });
  });
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
      response.end(); return;
    }
    if (request.method === "GET" && request.url === "/api/state") { sendJson(response, 200, publicState()); return; }
    if (request.method === "GET" && requestUrl.pathname === "/api/history") {
      const hours = Math.min(168, Math.max(1, Number(requestUrl.searchParams.get("hours")) || 24));
      const board = parseLeaderboard(requestUrl.searchParams.get("board"));
      const maxPoints = Math.min(480, Math.max(40, Number(requestUrl.searchParams.get("maxPoints")) || 240));
      sendJson(response, 200, { history: currentHistory(board)?.query({ hours, maxPoints }) ?? [], hours }); return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/pace") {
      const board = parseLeaderboard(requestUrl.searchParams.get("board"));
      sendJson(response, 200, { hours: 1, players: board === "poker_coin" ? [] : currentHistory(board)?.fitPaces({ hours: 1 }) ?? [] }); return;
    }
    if (request.method === "POST" && request.url === "/api/capture") { sendJson(response, 200, await runCapture()); return; }
    if (request.method === "POST" && request.url === "/api/shutdown") {
      sendJson(response, 202, { status: "stopping" });
      void shutdown(); return;
    }
    if (request.method === "POST" && request.url === "/api/settings") {
      const body = await readBody(request);
      if (typeof body.intervalMinutes === "number") config.intervalMinutes = Math.min(60, Math.max(1, Math.round(body.intervalMinutes)));
      if (typeof body.auto === "boolean") config.auto = body.auto;
      await persist(); schedule(); sendJson(response, 200, publicState()); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/latest.png")) {
      const image = await readFile(SCREENSHOT_FILE);
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      response.end(image); return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`むに Watch collector: http://127.0.0.1:${PORT}`);
  schedule();
  setTimeout(() => void backgroundCapture(), 800);
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  lifecycle("shutdown_requested");
  if (intervalHandle) clearInterval(intervalHandle);
  try { await capturePromise; }
  catch { console.error("Capture failed during shutdown; continuing reader cleanup"); }
  let exitCode = 0;
  try {
    await ocrClient.close();
    await runtimeClient.dispose();
  } catch {
    exitCode = 1;
    console.error("Reader cleanup failed; unresolved runtime ownership remains reserved");
  } finally {
    legacyHistory?.close();
    eventHistory.close();
    server.close(() => process.exit(exitCode));
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
