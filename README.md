# Muni Watch Local

Muni Watch Local is a local leaderboard monitor for **D4DJ Groovy Mix**. It is inspired by [muni-web](https://hamzaabamboo.github.io/muni-web/), but it does not intercept or decrypt game traffic.

Instead, the collector controls a MuMu Player instance through ADB, opens `ランキング` → `TOP20`, captures the emulator screen, and uses GPU-accelerated PaddleOCR to read the leading players and their total scores.

## Features

- Automatically refreshes the in-game TOP20 leaderboard.
- Reads up to seven player names and scores from a 1280 × 1280 emulator screen.
- Uses a persistent PP-OCRv6 recognition process with NVIDIA GPU acceleration.
- Rejects implausible OCR results using leaderboard ordering and score continuity checks.
- Stores long-term history in a local SQLite database.
- Displays current totals, recent score changes, one-hour fitted pace, gaps, catch-up estimates, and an interactive score chart.
- Provides a local control page and an optional read-only public page.

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 22.13 or newer
- Python 3.12
- [MuMu Player](https://www.mumuplayer.com/) with ADB enabled
- An NVIDIA GPU supported by PaddlePaddle
- [`uv`](https://docs.astral.sh/uv/) for the recommended Python setup
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) in `PATH` for temporary public sharing

The supplied screen regions and tap coordinates target a 1280 × 1280 MuMu window. Other layouts require configuration changes.

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

Prepare the PaddleOCR environment:

```
uv venv .venv-ppocr --python 3.12
uv pip install --python .venv-ppocr\Scripts\python.exe --index-url https://www.paddlepaddle.org.cn/packages/stable/cu129/ paddlepaddle-gpu==3.3.1
uv pip install --python .venv-ppocr\Scripts\python.exe -r requirements-ocr.txt
```

The default configuration requires `gpu:0`. The collector intentionally fails when the GPU runtime is unavailable instead of silently switching to a slower or different OCR engine.

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
4. Recognizes player names and total scores.
5. Validates and stores the result locally.

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
