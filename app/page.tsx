"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { catchUpLabel, catchUpMinutes, latestPositiveMovement, previousCaptureChange, scoreChangeAgeMinutes, scoreChangeFreshness, scoreAtRank } from "@/lib/pace";

function apiBase() {
  if (typeof window === "undefined") return "";
  return ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://127.0.0.1:4317"
    : "";
}

type BoardId = "total_pt" | "daily_pt" | "poker_coin";
const boardLabels: Record<BoardId, string> = { total_pt: "累計Pt", daily_pt: "今日Pt", poker_coin: "Poker Coin" };

type Entry = { rank: number; name: string; score: number; confidence?: number };
type Capture = { id: string; capturedAt: string; entries: Entry[] };
type FittedPace = { rank: number; name: string; rate: number | null; samples: number };
type MonitorState = {
  status: "booting" | "capturing" | "idle" | "error";
  lastUpdated: string | null;
  lastError: string | null;
  history: Capture[];
  boards?: Partial<Record<BoardId, { name: string; dayNumber: number; history: Capture[]; lastUpdated: string | null }>>;
  config: { intervalMinutes: number; auto: boolean; eventName: string; leaderboard: string; maxEntries: number };
  mumu: { name: string; connected: boolean; screen: string };
  ocr: { engine: string; model: string; device: string; gpu: string } | null;
};

const nf = new Intl.NumberFormat("ja-JP");

function compactNumber(value: number) {
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}億`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return nf.format(value);
}

function collectorStatusLabel(status?: MonitorState["status"]) {
  return ({ booting: "起動中", capturing: "取得中", idle: "待機中", error: "エラー" } as const)[status ?? "booting"];
}

function collectorErrorLabel(error: string) {
  return error
    .replace("MuMu ADB 未连接", "MuMuのADBに接続できません")
    .replace("未能从 TOP20 返回活动页", "TOP20画面からイベントトップへ戻れませんでした")
    .replace("未能进入 TOP20 页面，请先把游戏停在活动首页", "TOP20画面を開けませんでした。ゲームをイベントトップ画面に戻してください");
}

function timeLabel(value?: string | null) {
  if (!value) return "まだ取得していません";
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function elapsedLabel(value?: string | null) {
  if (!value) return "未取得";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  return `${Math.floor(seconds / 3600)}時間前`;
}

const rankColors = ["#d5960f", "#2168e8", "#d55374", "#16845f", "#7656c8", "#e06b25", "#118f9e"];

function ScoreTrendChart({ history, entries, hours, onHoursChange }: { history: Capture[]; entries: Entry[]; hours: number; onHoursChange: (hours: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverPoint, setHoverPoint] = useState<{ index: number; x: number; alignRight: boolean } | null>(null);
  const captures = useMemo(() => history, [history]);
  const players = useMemo(() => entries.slice(0, 7), [entries]);
  const hoverCapture = hoverPoint ? captures[hoverPoint.index] : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const width = Math.max(320, canvas.clientWidth);
      const height = Math.max(250, canvas.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const plot = { left: 76, right: 20, top: 18, bottom: 38 };
      const plotWidth = width - plot.left - plot.right;
      const plotHeight = height - plot.top - plot.bottom;
      const series = players.map((player) => captures.map((capture) => scoreAtRank(capture, player.rank)));
      const allValues = series.flatMap((values) => values.filter((value): value is number => value != null));

      if (captures.length < 2 || allValues.length < 2) {
        context.fillStyle = "#6e7380";
        context.font = "600 12px ui-monospace, monospace";
        context.fillText("データ待ち", plot.left, plot.top + plotHeight / 2);
        return;
      }

      const rawMinimum = Math.min(...allValues);
      const rawMaximum = Math.max(...allValues);
      const padding = Math.max((rawMaximum - rawMinimum) * 0.08, rawMaximum * 0.002, 1);
      const minimum = Math.max(0, rawMinimum - padding);
      const maximum = rawMaximum + padding;
      const range = Math.max(1, maximum - minimum);
      const xAt = (index: number) => plot.left + (index / Math.max(1, captures.length - 1)) * plotWidth;
      const yAt = (value: number) => plot.top + ((maximum - value) / range) * plotHeight;

      context.lineWidth = 1;
      context.font = "600 10px ui-monospace, monospace";
      context.textAlign = "right";
      context.textBaseline = "middle";
      for (let index = 0; index <= 4; index += 1) {
        const y = plot.top + (index / 4) * plotHeight;
        const value = maximum - (index / 4) * range;
        context.strokeStyle = "#e3e4e8";
        context.beginPath();
        context.moveTo(plot.left, y);
        context.lineTo(width - plot.right, y);
        context.stroke();
        context.fillStyle = "#7a7f8b";
        context.fillText(compactNumber(Math.round(value)), plot.left - 10, y);
      }

      context.textBaseline = "top";
      const labelIndexes = [0, Math.floor((captures.length - 1) / 2), captures.length - 1];
      for (const [position, index] of labelIndexes.entries()) {
        context.textAlign = position === 0 ? "left" : position === 2 ? "right" : "center";
        context.fillStyle = "#7a7f8b";
        context.fillText(timeLabel(captures[index].capturedAt), xAt(index), height - plot.bottom + 13);
      }

      players.forEach((player, colorIndex) => {
        context.strokeStyle = rankColors[colorIndex];
        context.lineWidth = 2.5;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.beginPath();
        let drawing = false;
        series[colorIndex].forEach((value, index) => {
          if (value == null) { drawing = false; return; }
          const x = xAt(index);
          const y = yAt(value);
          if (drawing) context.lineTo(x, y);
          else { context.moveTo(x, y); drawing = true; }
        });
        context.stroke();

        const latestIndex = series[colorIndex].findLastIndex((value) => value != null);
        const latestValue = latestIndex >= 0 ? series[colorIndex][latestIndex] : null;
        if (latestValue != null && latestIndex >= 0) {
          context.fillStyle = rankColors[colorIndex];
          context.beginPath();
          context.arc(xAt(latestIndex), yAt(latestValue), 4, 0, Math.PI * 2);
          context.fill();
        }
      });

      if (hoverPoint && captures[hoverPoint.index]) {
        const hoverX = xAt(hoverPoint.index);
        context.strokeStyle = "rgba(21, 25, 38, .42)";
        context.lineWidth = 1;
        context.setLineDash([4, 4]);
        context.beginPath();
        context.moveTo(hoverX, plot.top);
        context.lineTo(hoverX, plot.top + plotHeight);
        context.stroke();
        context.setLineDash([]);

        players.forEach((_, colorIndex) => {
          const value = series[colorIndex][hoverPoint.index];
          if (value == null) return;
          context.fillStyle = "#fff";
          context.strokeStyle = rankColors[colorIndex];
          context.lineWidth = 2.5;
          context.beginPath();
          context.arc(hoverX, yAt(value), 5, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        });
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [captures, players, hoverPoint]);

  useEffect(() => {
    const clearHover = () => setHoverPoint(null);
    window.addEventListener("resize", clearHover);
    return () => window.removeEventListener("resize", clearHover);
  }, []);

  const selectHoverPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (captures.length < 2) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const plotLeft = 76;
    const plotRight = 20;
    const plotWidth = Math.max(1, bounds.width - plotLeft - plotRight);
    const x = Math.min(bounds.width - plotRight, Math.max(plotLeft, event.clientX - bounds.left));
    const index = Math.round(((x - plotLeft) / plotWidth) * (captures.length - 1));
    setHoverPoint({ index, x, alignRight: x > bounds.width / 2 });
  };

  return (
    <article className="score-chart-panel" aria-labelledby="score-chart-title">
      <div className="chart-head">
        <div><p className="section-kicker">長期スコア</p><h3 id="score-chart-title">総ポイント推移</h3></div>
        <div className="chart-tools">
          <div className="trend-window" aria-label="グラフの表示期間">
            {[1, 6, 24, 168].map((value) => <button type="button" className={hours === value ? "active" : ""} onClick={() => onHoursChange(value)} key={value}>{value === 168 ? "7日" : `${value}時間`}</button>)}
          </div>
          <div className="chart-legend" aria-label="順位別の色分け">
            {players.map((player, index) => <span key={player.rank}><i style={{ backgroundColor: rankColors[index] }} />#{player.rank} {player.name}</span>)}
          </div>
        </div>
      </div>
      <div className="chart-canvas-wrap">
        <canvas
          ref={canvasRef}
          role="img"
          tabIndex={0}
          aria-label={`上位${players.length || 7}順位の直近${hours === 168 ? "7日間" : `${hours}時間`}の総ポイント推移。グラフにポインターを重ねると各時点の得点を確認できます`}
          onPointerMove={selectHoverPoint}
          onPointerLeave={() => setHoverPoint(null)}
        />
        {hoverCapture && hoverPoint && (
          <div className={`chart-tooltip ${hoverPoint.alignRight ? "align-right" : ""}`} style={{ left: hoverPoint.x }} role="status" aria-live="polite">
            <time>{new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(hoverCapture.capturedAt))}</time>
            {players.map((player, index) => {
              const historicalEntry = hoverCapture.entries.find((entry) => entry.rank === player.rank);
              const score = scoreAtRank(hoverCapture, player.rank);
              return <div key={player.rank}><i style={{ backgroundColor: rankColors[index] }} /><span>#{player.rank} {historicalEntry?.name ?? "—"}</span><strong>{score == null ? "—" : nf.format(score)} Pt</strong></div>;
            })}
          </div>
        )}
      </div>
    </article>
  );
}

export default function Home() {
  const [selectedBoard, setSelectedBoard] = useState<BoardId>("total_pt");
  const boardRef = useRef<BoardId>("total_pt");
  const trendRequest = useRef(0);
  const paceRequest = useRef(0);
  const [state, setState] = useState<MonitorState | null>(null);
  const [connected, setConnected] = useState(false);
  const [canControl, setCanControl] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [trendHistory, setTrendHistory] = useState<Capture[]>([]);
  const [trendHours, setTrendHours] = useState(24);
  const [fittedPaces, setFittedPaces] = useState<Record<number, FittedPace>>({});
  const [now, setNow] = useState(() => Date.now());

  const boardState = state?.boards?.[selectedBoard];
  const boardHistory = boardState?.history ?? (selectedBoard === "total_pt" ? state?.history ?? [] : []);
  const boardUpdated = boardState?.lastUpdated ?? (selectedBoard === "total_pt" ? state?.lastUpdated : null);
  const showPace = selectedBoard !== "poker_coin";

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/state`, { cache: "no-store" });
      if (!response.ok) throw new Error("collector unavailable");
      setState(await response.json());
      setConnected(true);
    } catch { setConnected(false); }
  }, []);

  const refreshTrend = useCallback(async () => {
    const request = ++trendRequest.current;
    try {
      const response = await fetch(`${apiBase()}/api/history?hours=${trendHours}&board=${selectedBoard}&maxPoints=240`, { cache: "no-store" });
      if (!response.ok) throw new Error("history unavailable");
      const payload = await response.json() as { history: Capture[] };
      if (boardRef.current === selectedBoard && request === trendRequest.current) setTrendHistory(payload.history);
    } catch { /* The live JSON history remains available as a fallback. */ }
  }, [trendHours, selectedBoard]);

  const refreshPaces = useCallback(async () => {
    const request = ++paceRequest.current;
    if (selectedBoard === "poker_coin") return;
    try {
      const response = await fetch(`${apiBase()}/api/pace?board=${selectedBoard}`, { cache: "no-store" });
      if (!response.ok) throw new Error("pace unavailable");
      const payload = await response.json() as { players: FittedPace[] };
      if (boardRef.current === selectedBoard && request === paceRequest.current) setFittedPaces(Object.fromEntries(payload.players.map((player) => [player.rank, player])));
    } catch { /* Fall back to the latest positive movement until DB pace is available. */ }
  }, [selectedBoard]);

  useEffect(() => {
    queueMicrotask(() => setCanControl(["localhost", "127.0.0.1"].includes(window.location.hostname)));
    queueMicrotask(() => void refresh());
    const poll = window.setInterval(refresh, 4000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(poll); window.clearInterval(clock); };
  }, [refresh]);

  useEffect(() => { queueMicrotask(() => void refreshTrend()); }, [refreshTrend, boardUpdated]);
  useEffect(() => { queueMicrotask(() => void refreshPaces()); }, [refreshPaces, boardUpdated]);

  const captureNow = async () => {
    if (!canControl) return;
    setAction("MuMuを操作して取得中…");
    try {
      const response = await fetch(`${apiBase()}/api/capture`, { method: "POST" });
      if (!response.ok) throw new Error("capture failed");
      setState(await response.json());
      setAction(null);
    } catch {
      setAction("取得に失敗しました");
      window.setTimeout(() => setAction(null), 2400);
    }
  };

  const updateSettings = async (patch: { intervalMinutes?: number; auto?: boolean }) => {
    if (!state || !canControl) return;
    setState({ ...state, config: { ...state.config, ...patch } });
    try {
      const response = await fetch(`${apiBase()}/api/settings`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error("update failed");
      setState(await response.json());
    } catch { refresh(); }
  };

  const current = boardHistory.at(-1);
  const displayLimit = state?.config.maxEntries ?? 20;
  const displayRanks = useMemo(() => Array.from({ length: displayLimit }, (_, index) => index + 1), [displayLimit]);
  const entries = (current?.entries ?? []).slice(0, displayLimit);
  const recentCaptures = boardHistory.slice(-6).reverse();
  const nextCapture = (() => {
    if (!state?.lastUpdated || !state.config.auto) return null;
    const target = new Date(state.lastUpdated).getTime() + state.config.intervalMinutes * 60_000;
    return Math.max(0, Math.ceil((target - now) / 1000));
  })();

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="むに Watch ホーム"><span className="brand-mark">む</span><span>むに Watch</span></a>
        <div className="topbar-status"><span className={`signal ${connected ? "online" : "offline"}`} />{connected ? (canControl ? "ローカル・稼働中" : "公開ページ・閲覧専用") : "収集サービス停止中"}</div>
      </header>

      <div className="page-shell" id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">D4DJ Groovy Mix · イベント追跡</p>
            <h1>{state?.config.eventName ?? "ローカルランキング監視"}</h1>
            <p className="hero-subtitle">MuMu の「ランキング → TOP20」を定期取得。上位{displayLimit}名の変化を、静かに追いかけます。</p>
          </div>
          <div className="hero-meta">
            <div><span>ランキング</span><strong>{boardLabels[selectedBoard]} · TOP20</strong></div>
            <div><span>最終更新</span><strong>{elapsedLabel(boardUpdated)}</strong></div>
          </div>
        </section>

        {!connected && <section className="offline-banner"><span>!</span><div><strong>収集サービスに接続できません</strong><p>プロジェクトフォルダーで「npm run local」を実行すると、このページは自動的に再接続します。</p></div></section>}

        <nav className="section-tabs" aria-label="ページ内メニュー">{(["total_pt", "daily_pt", "poker_coin"] as BoardId[]).map(board => <button type="button" key={board} className={selectedBoard === board ? "active" : ""} aria-pressed={selectedBoard === board} onClick={() => {
          boardRef.current = board; setSelectedBoard(board); setTrendHistory([]); setFittedPaces({});
        }}>{board === "total_pt" ? "ランキング" : boardLabels[board]}</button>)}{canControl && <><a href="#history">取得履歴</a><a href="#collector">収集設定</a></>}</nav>

        <section className="ranking-section" id="ranking">
          <div className="section-heading"><div><p className="section-kicker">トップ{displayLimit}・リアルタイム</p><h2>{boardLabels[selectedBoard]}ランキング{selectedBoard === "daily_pt" && boardState ? ` · ${boardState.dayNumber}日目` : ""}</h2></div><p>最終取得 · {timeLabel(boardUpdated)}</p></div>
          <div className="ranking-table-wrap">
            <table className="ranking-table">
              <thead>
                <tr><th>順位 / プレイヤー</th><th>{showPace ? "ポイント" : "Poker Coin"}</th><th>今回の増加</th>{showPace && <th>1時間ペース</th>}<th>下位との差</th>{showPace && <th>追いつかれるまで</th>}</tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const movement = showPace ? latestPositiveMovement(boardHistory, entry) : null;
                  const delta = showPace ? movement?.delta ?? null : previousCaptureChange(boardHistory, entry.rank);
                  const fittedPace = fittedPaces[entry.rank];
                  const rate = fittedPace?.rate ?? movement?.rate ?? null;
                  const changeAge = movement && current ? scoreChangeAgeMinutes(current.capturedAt, movement.capturedAt) : null;
                  const changeFreshness = changeAge == null ? "unknown" : scoreChangeFreshness(changeAge);
                  const pursuer = entries.find((candidate) => candidate.rank === entry.rank + 1);
                  const pursuerMovement = showPace && pursuer ? latestPositiveMovement(boardHistory, pursuer) : null;
                  const pursuerRate = pursuer ? fittedPaces[pursuer.rank]?.rate ?? pursuerMovement?.rate ?? null : null;
                  const gap = pursuer ? Math.max(0, entry.score - pursuer.score) : null;
                  const catchEta = catchUpLabel(gap == null ? null : catchUpMinutes(gap, rate, pursuerRate));
                  return (
                    <tr className={`rank-row rank-${entry.rank}`} key={entry.rank}>
                      <th scope="row">
                        <span className="rank-identity">
                          <span className="rank-badge">{entry.rank}</span>
                          <span className="rank-player"><strong>{entry.name}</strong></span>
                        </span>
                      </th>
                      <td className="total-cell"><strong>{nf.format(entry.score)}</strong></td>
                      <td className={`change-cell freshness-${showPace ? changeFreshness : "now"}`}><strong>{delta == null ? "—" : `${delta > 0 ? "+" : ""}${nf.format(delta)}`}</strong><small>{showPace ? changeAge == null ? "更新待ち" : `${changeAge}分前` : "前回取得との差"}</small></td>
                      {showPace && <td><strong>{rate == null ? "—" : compactNumber(rate)}</strong></td>}
                      <td><strong>{gap == null ? "----" : nf.format(gap)}</strong></td>
                      {showPace && <td><strong>{catchEta}</strong></td>}
                    </tr>
                  );
                })}
                {entries.length === 0 && <tr className="ranking-empty"><td colSpan={showPace ? 6 : 4}>取得後、トップ{displayLimit}のプレイヤー名とスコアがここに表示されます</td></tr>}
              </tbody>
            </table>
          </div>
          {showPace && <ScoreTrendChart history={trendHistory.length ? trendHistory : boardHistory} entries={entries} hours={trendHours} onHoursChange={setTrendHours} />}
        </section>

        {canControl && <section className="lower-grid">
          <article className="panel history-panel" id="history">
            <div className="panel-head"><div><p className="section-kicker">スナップショット</p><h2>取得履歴</h2></div><span>{boardHistory.length}件</span></div>
            <div className="history-table" role="table" aria-label="最近の取得履歴" style={{ "--history-ranks": displayLimit } as React.CSSProperties}>
              <div className="history-row history-header" role="row"><span>時刻</span>{displayRanks.map((rank) => <span key={rank}>{rank}位</span>)}</div>
              {recentCaptures.map((capture) => <div className="history-row" role="row" key={capture.id}><span>{timeLabel(capture.capturedAt)}</span>{displayRanks.map((rank) => <strong key={rank}>{nf.format(scoreAtRank(capture, rank) ?? 0)}</strong>)}</div>)}
              {recentCaptures.length === 0 && <p className="empty-copy">まだ履歴がありません。</p>}
            </div>
          </article>

          <aside className="panel collector-panel" id="collector">
            <div className="panel-head"><div><p className="section-kicker">ローカル自動取得</p><h2>収集設定</h2></div><span className={`collector-state ${state?.status ?? "booting"}`}>{collectorStatusLabel(state?.status)}</span></div>
            <div className="collector-device"><div className="device-icon">M</div><div><span>MU MU PLAYER</span><strong>{state?.mumu.name ?? "Android Device"}</strong></div><i className={state?.mumu.connected ? "ready" : ""} /></div>
            <label className="setting-row"><span>自動取得の間隔</span><select value={state?.config.intervalMinutes ?? 5} onChange={(event) => updateSettings({ intervalMinutes: Number(event.target.value) })} disabled={!connected || !canControl}>{[1, 2, 3].map((minute) => <option value={minute} key={minute}>{minute}分</option>)}</select></label>
            <label className="setting-row switch-row"><span>自動取得</span><input type="checkbox" checked={state?.config.auto ?? false} onChange={(event) => updateSettings({ auto: event.target.checked })} disabled={!connected || !canControl} /><span className="switch" /></label>
            <button className="capture-button" onClick={captureNow} disabled={!connected || !canControl || state?.status === "capturing"}><span>↻</span>{action ?? (canControl ? "今すぐ取得" : "公開ページでは閲覧のみ")}</button>
            <div className="collector-foot"><span>次回</span><strong>{nextCapture == null ? "停止中" : `${Math.floor(nextCapture / 60)}:${String(nextCapture % 60).padStart(2, "0")}`}</strong><span>取得方式</span><strong>{state?.ocr?.engine ?? "IL2CPP"}</strong></div>
            {state?.lastError && <p className="error-copy">{collectorErrorLabel(state.lastError)}</p>}
          </aside>
        </section>}

        {/* The collector serves the original local screenshot directly without an image proxy. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {canControl && <section className="source-strip"><div><span className="section-kicker">最新の取得画像</span><h2>MuMuスクリーンショット</h2><p>{state?.ocr?.engine === "IL2CPP" ? "TOP20のランキングデータをゲーム内から直接取得します。" : `ランキング上位${displayLimit}行をOCRで読み取ります。`}元画像はローカルに保存され、外部には送信されません。</p></div>{state?.lastUpdated ? <img src={`${apiBase()}/latest.png?t=${new Date(state.lastUpdated).getTime()}`} alt="MuMu TOP20の最新スクリーンショット" /> : <div className="image-placeholder">取得待ち</div>}</section>}
      </div>

      <footer><span>むに Watch / ローカル版</span><span>MuMuから取得 · muni-webを参考に制作</span></footer>
    </main>
  );
}
