# Contributor Guide

## Scope

This repository contains a Windows-oriented local monitor for a MuMu-hosted D4DJ Groovy Mix leaderboard. Keep collection local, preserve the public gateway's read-only boundary, and do not add packet interception or game-traffic decryption.

## Architecture

- `app/`: Vinext/React interface. The same frontend is used for local control and public read-only display.
- `collector/`: TypeScript collector, YAML validation, OCR client, score validation, name stabilization, and SQLite history.
- `collector/ppocr_worker.py`: persistent PaddleOCR worker. Python is retained because PaddleOCR is a Python library; all Node.js application and test code is TypeScript.
- `scripts/local.ts`: starts the local frontend and collector.
- `scripts/public-gateway.ts`: read-only reverse proxy for public access.
- `scripts/public.ts`: production frontend, gateway, Cloudflare tunnel, and frontend hot-reload orchestration.
- `config/muni.example.yml`: only configuration file intended for source control.
- `data/`: private runtime state and downloaded models; only `.gitkeep` may be committed.

## Commands

```powershell
npm install
npm run typecheck
npm test
npm run lint
npm run local
```

`npm test` performs a production build before running TypeScript tests. Run both `npm run typecheck` and `npm test` before handing off changes to collector, configuration, scripts, or UI behavior.

## TypeScript conventions

- Keep `strict` mode passing without `any` escapes unless an external API makes them unavoidable.
- Put shared collector data shapes in `collector/types.ts`.
- Use explicit `.ts` extensions for local imports executed through `tsx`.
- Do not reintroduce `.mjs` runtime or test files. Build-tool configuration may remain in its framework-required format.
- Preserve validation at process boundaries: YAML, OCR worker messages, HTTP request bodies, and SQLite rows.

## Configuration changes

When changing the configuration schema:

1. Update `MuniConfig` in `collector/types.ts`.
2. Update validation and serialization in `collector/config.ts`.
3. Update `config/muni.example.yml` with anonymous values.
4. Update configuration tests.
5. Document user-facing changes in `README.md`.

Never place real player names, event names, ADB paths unique to a contributor, tunnel identifiers, or device labels in example files or tests.

## Data and privacy

Treat all files below as sensitive local artifacts:

- `config/muni.yml`
- `data/**`
- `tools/quick-tunnel.yml`
- root service logs and Python caches

Do not weaken the relevant `.gitignore` rules. Tests must create databases under a temporary directory and remove them afterward. Public endpoints must remain read-only and must not expose configuration, environment variables, local paths, control endpoints, or files outside the intended screenshot/history APIs.

## Collector behavior

- The game does not refresh scores while TOP20 stays open, so collection must leave and re-enter the ranking screen.
- Scores are monotonic. Retain descending-rank validation and same-player continuity checks when changing OCR logic.
- The default 1280 × 1280 crop regions support seven rows. Coordinate changes require a screenshot-based verification and regression coverage where practical.
- Do not silently fall back from GPU PaddleOCR to another engine.

## Public deployment

The gateway must accept only `GET` and `HEAD`. Local control endpoints (`POST /api/capture` and `POST /api/settings`) must never be exposed publicly. Preserve the existing frontend reload behavior so `npm run public:update` does not replace an active tunnel URL.
