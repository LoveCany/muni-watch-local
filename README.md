# Muni Watch Local

Muni Watch Local is a local leaderboard monitor for **D4DJ Groovy Mix**. It is inspired by [muni-web](https://hamzaabamboo.github.io/muni-web/), but it does not intercept or decrypt game traffic.

By default, the collector controls MuMu through ADB, opens `ランキング` → `TOP20`, and reads the top 20 nicknames and total Pt directly from the active IL2CPP ranking data. Screenshots confirm screen readiness and provide a local preview; they are not the data source. GPU PaddleOCR remains available through explicit `captureMode: ocr`.

## Features

- Automatically refreshes the in-game TOP20 leaderboard.
- Reads all 20 displayed ranking entries directly through IL2CPP.
- Retains an explicit GPU OCR mode for the original seven-row 1280 × 1280 layout.
- Validates leaderboard ordering and score continuity within each activity. Continuity, score curves, deltas and fitted pace follow each rank, regardless of nickname changes or changes in the player occupying that rank. Nicknames are display labels; chart tooltips show the nickname recorded at that time.
- Stores each activity in its own SQLite database, with dedicated total Pt tables.
- Displays current totals, recent score changes, one-hour fitted pace, gaps, catch-up estimates, and an interactive score chart.
- Provides a local control page and an optional read-only public page.

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 22.13 or newer
- [MuMu Player](https://www.mumuplayer.com/) with ADB enabled
- Rooted 64-bit MuMu, the validated D4DJ 10.8.0 APK, and an already running Frida 17.20.0 server
- Python 3.12, an NVIDIA GPU and [`uv`](https://docs.astral.sh/uv/) only for explicit OCR mode
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) in `PATH` for temporary public sharing

The default tap coordinates target the verified 1920 × 1080 landscape layout. Other layouts require screenshot-based verification and configuration changes.

## Installation

Clone the repository and install the Node.js dependencies:

```
npm install
```

Create a private configuration file from the sanitized example:

```
cp config/muni.example.yml config/muni.yml
```

Edit `config/muni.yml` and set at least:

- `adbPath`: path to the ADB executable bundled with MuMu Player
- `serial`: ADB address of the MuMu instance to monitor
- `deviceName`: label shown in the local UI; defaults to `Android Device`
- `eventName` and `leaderboard`: labels shown on the page
- `screen` and `taps`: emulator resolution and tap coordinates
- `nameCorrections`: optional OCR name corrections specific to your leaderboard

IL2CPP mode does not require PaddleOCR installation. For explicit OCR mode, set `captureMode: ocr`, `maxEntries: 7`, a 1280 × 1280 screen and taps `back: (49,49)`, `ranking: (439,825)`, `top20: (640,185)`. Older configurations without `captureMode` must explicitly select OCR if they use seven entries. Then prepare the PaddleOCR environment:

```
uv venv .venv-ppocr --python 3.12
uv pip install --python .venv-ppocr\Scripts\python.exe --index-url https://www.paddlepaddle.org.cn/packages/stable/cu129/ paddlepaddle-gpu==3.3.1
uv pip install --python .venv-ppocr\Scripts\python.exe -r requirements-ocr.txt
```

Explicit OCR mode requires `gpu:0`. The collector intentionally fails when the GPU runtime is unavailable instead of silently switching to a slower or different OCR engine.

## Running locally

Start MuMu Player, open the game, and leave it on the event home screen. Then run:

```
npm run local
```

Open [http://localhost:3002](http://localhost:3002). The collector API listens only on `127.0.0.1:4317`.

On every interval the collector:

1. Leaves the TOP20 screen when necessary.
2. Reopens `ランキング` and `TOP20` to force a fresh in-game response.
3. Captures the emulator screen through ADB.
4. Reads nicknames and total Pt directly from the active IL2CPP TOP20 data.
5. Validates and stores the result locally.

## Default IL2CPP capture

The example configuration uses `captureMode: il2cpp` and `maxEntries: 20`; an omitted `captureMode` also defaults to IL2CPP. The retained `ocr` settings and `nameCorrections` apply only to explicit OCR mode. The active profile targets the statically reviewed and live-tested D4DJ 11.0.1 APK on a rooted 64-bit MuMu instance with an already running Frida 17.20.0 server. It validates IL2CPP instruction bytes before managed calls instead of requiring an exact APK SHA256. Game updates require the addresses and layouts in `config/il2cpp-runtime.json` to be checked against the new binary and metadata. It does not start or restart services.

The reader follows the active event ranking view and reads board name, daily period, rank, nickname and integer score from its `EventRankingData[]`. It validates a complete descending TOP20 twice and rejects a screen/list change during capture. The existing leave/re-enter/TOP20 refresh sequence, minute interval, score continuity checks and local history remain in use. Tap coordinates still need to match the actual emulator layout. OCR configuration is retained for explicit legacy mode; direct mode does not start PaddleOCR or silently fall back to it.

A manual probe exports a private snapshot to `data/il2cpp-probe.json`:

```powershell
npm run probe:ranking -- --trace
```

The probe accepts `--adb` and `--serial` overrides without rewriting configuration. Add `--refresh --landscape-1080 --count 2` to validate two refreshed captures one configured interval apart. The observed 1920 x 1080 layout uses back (75,60), ranking (655,400), and TOP20 (960,280). The collector uses the same refresh function with its configured screen and taps. Trace output contains only operation stages, never player records. A native operation that does not settle within 30 seconds fails the host capture even if cancellation is ignored. A pending native operation prevents a fresh attachment in that client. Resolve the test process before retrying a stalled native call.

Prior live validation on D4DJ 10.8.0 passed two complete ADB-refreshed 20-row snapshots about 66 seconds apart, followed by handle cleanup and session detachment. The integrated collector also passed three automatic captures in the current activity database, with 60 ranking rows and complete ranks 1–20 in each capture. Long-running soak testing, exit-time disk failures and other game builds remain unverified.

Each activity uses a new database at `data/events/<event-id>.sqlite`. The total Pt board uses its own `total_pt_captures` and `total_pt_ranking_entries` tables; future boards can use separate table prefixes within that activity database. Native collector state lives in `data/il2cpp-state.json`. Existing OCR history databases and state files are not opened or migrated by native mode. Same-rank continuity applies within the current activity, so an earlier activity cannot reject a new activity's lower initial Pt. The event ID is internal routing metadata; probe exports contain timestamps, board names, daily periods, ranks, nicknames and scores. The carousel is sampled once per minute: total Pt, daily Pt and Poker Coin, returning to total Pt. Every board uses the same verified TOP20 row layout, with the exact ranking name validated before routing. Daily Pt uses the managed `DayNumber` property and separate `daily_pt_day_<n>_` tables; its history and continuity baseline reset when the game changes the day number. Poker Coin uses `poker_coin_` tables, keeps descending-rank validation, and has no monotonic-score check or pace API results. Each board is committed before switching; a later board failure preserves the boards already stored and reports a collector error. Events with only the total Pt carousel remain supported.

The shared D4DJ analysis workspace contains `IL2CPP_11.0.1_AUDIT.md`, which records the new API addresses, unchanged layouts, source provenance and cleanup. Two ADB-refreshed TOP20 captures and clean reader shutdown passed on 11.0.1; long-running collection and future activities remain unverified.

## Updating the IL2CPP runtime profile

All game-specific native addresses and memory offsets are owned by `config/il2cpp-runtime.json`. The `label` identifies the analyzed build for maintainers; it does not gate a game version. Offsets and RVAs are non-negative decimal byte values, and instruction guards are eight bytes written as 16 lowercase hexadecimal characters.

- `api`: IL2CPP API RVAs and instruction guards, including the APIs used inside the native main-thread callback. There are no duplicate callback API addresses in JavaScript.
- `buildGuard`: the existing binary-layout signature used on the MuMu guest mapping.
- `layout`: managed array/string headers, boxed values, `MethodInfo`, and the ranking/event/profile field offsets.
- `nativeBridge` and `javaVM`: the observed emulator bridge and JNI interface offsets. Recheck these if the emulator runtime changes.

After a game update, compare the matching Il2CppDumper output (`dump.cs`, `script.json`, and `il2cpp.h`) and the native binary against this profile, update the affected values, then run `npm run typecheck` and `npm test`. Dump output alone does not prove the native API calling convention or GC-handle representation. The helper still supports the observed 64-bit pointer GC handles and its fixed task payload; a change to that ABI needs a source change rather than an offset edit.

If `layout.array.data` changes, rebuild `unity_invoke.so` with `uv run --cache-dir .npm-cache/uv --no-project --with keystone-engine==0.9.2 python collector/native/build_helper.py`. Its assembly reads this header offset from the same profile. The client checks the embedded helper layout marker before attaching and rejects a stale helper. Other profile-only address/field changes do not require rebuilding the helper.

An invalid profile fails before attachment. Every configured native API target is checked on script load, and the main-thread callback targets are checked again when posted. Content-addressed helper files are uploaded only if absent; an existing matching helper is reused without overwriting its loaded inode. Guest mappings from an earlier overwritten inode are recognized only for the exact helper path and a matching embedded layout marker. The helper's SHA256 still verifies its upload; only the whole-APK SHA256 restriction has been removed. Restart the collector through its normal clean shutdown before loading a changed profile, then validate one complete capture, cleanup, and two refreshed captures. A new game build remains unverified until those live checks pass.

## Service recovery and diagnostics

Lifecycle records are written locally under `data/service-logs/<service>-<pid>.jsonl`, one file per writer. They contain start/exit times, process/parent IDs, child exit codes and signals, and error categories. They do not record configuration or ranking rows. When launching services in the background, retain stdout/stderr as local files as well; lifecycle hooks cannot run when Windows forcibly terminates a process.

The local launcher records a child failure without immediately killing the other service. Scheduled capture failures, including persistence failures, are handled at the background-operation boundary instead of becoming unhandled Promise rejections. In IL2CPP mode, refresh uses the device's Android Back key; a corner tap can be ignored even while the game continues rendering. Transitions are checked with a finite wait, without sending Back twice.

`POST http://127.0.0.1:4317/api/shutdown` requests a clean collector shutdown: wait for the active capture, release reader resources, close the Frida DeviceManager, close history, then exit. The local launcher uses this endpoint before stopping. The public gateway rejects this POST just like other control requests. If a native operation is unresolved, its ownership marker remains reserved; do not delete it and inject another reader into the same game process.

## Temporary public sharing

Keep `npm run local` running. In a second terminal, run:

```
npm run public
```

The command builds the production frontend, starts a read-only gateway, and asks Cloudflare Quick Tunnel for a temporary `https://*.trycloudflare.com` URL.

The public gateway permits only `GET` and `HEAD` requests. Capturing the screen and changing collector settings remain available only from the local page. Quick Tunnel URLs are temporary and normally change after a restart; use a named Cloudflare Tunnel if you require a stable domain.

After changing frontend code while the public launcher is running, apply the new build without replacing the active tunnel:

```
npm run public:update
```

## Privacy

All OCR models, screenshots, player names, scores, configuration, service logs, JSON state, and SQLite files remain local by default. They are excluded by `.gitignore`.

Before publishing a fork, verify that only sanitized `*.example.yml` configuration files are staged. Never commit the contents of `config/muni.yml` or `data/`.

## License

This project is available under the [MIT License](LICENSE).

### Leaderboard tabs and updates

The Ranking, Today Pt and Poker Coin tabs select independent histories. Pt curves, deltas and fitted pace follow rank, not nickname. Poker Coin shows the ranking, coin count, most recent positive change at the same rank and the minutes since that change (retained across unchanged polls), and gap; it does not calculate scoring speed or catch-up estimates. The daily tab displays the game-provided event day number, and its chart covers that day's data.

The existing read-only APIs accept `board=total_pt|daily_pt|poker_coin`; omitted board parameters retain total Pt behavior. Unknown boards are rejected. `/api/pace?board=poker_coin` returns no pace rows. New boards use the same public read-only gateway routes; local capture and settings controls remain private.

For frontend changes, use `npm run public:update` while the public launcher remains running. It reloads the production frontend without restarting cloudflared or changing the existing URL. Reload only the collector when collection code changes; preserve the public launcher, gateway and tunnel processes during routine updates.
