# Streambert Web Port — Architecture & Contract

Goal: run Streambert as a **self-hosted web app** (host on the Vision server, use from
phone / laptop / iPad browsers) while **reusing the existing React UI, UX, and assets**.
This document is the shared interface every subsystem/agent codes against. Do not diverge
from it without updating it here first.

## What already works in a browser (no change needed)

- **TMDB** and **AniList** are called directly from the renderer via `fetch` (CORS-OK) — `src/utils/api.js`.
- **Settings / library / watch-progress** persist in `localStorage` — `src/utils/storage.js`.
- **Movie/TV playback** for `videasy` / `vidsrc` / `2embed` is **iframe-embed URLs** — load directly in `<iframe>`.
- The code already guards Electron-only paths with `isElectron = !!window.electron`.

## What is Electron-only and must be replaced

| Capability | IPC method(s) | Web replacement |
|---|---|---|
| Secure key store (TMDB/Wyzie/SubDL keys) | `secureGet/secureSet` | shim → `GET/PUT /api/secure/:key` (server, behind auth) |
| Anime resolve (AllManga scrape) | `resolveAllManga`, `debugAllManga`, `setPlayerVideo` | shim → `POST /api/allmanga/*` |
| Downloads (m3u8/mp4, multithread) | `runDownload`, `getDownloads`, `deleteDownload`, `checkDownloader`, `onDownloadProgress`, `*Size`, `deleteAllDownloads`, `scanDirectory`, `fileExists` | shim → `/api/downloads/*` + WS + `/api/files/*` |
| Subtitles search/download | `searchSubtitles`, `getSubtitleUrl`, `downloadSubtitlesForFile`, `deleteSubtitleFile`, `wyzieValidateKey`, `wyzieOpenRedeem` | shim → `/api/subtitles/*`, `/api/wyzie/*` |
| Stream CDN segments (Referer/Origin-gated) | (internal) | `GET /api/proxy?url=…` header-spoof + CORS + Range |
| m3u8/subtitle sniffing during embed playback | `onM3u8Found`, `onSubtitleFound` | **deferred**: needs server-side Playwright extractor (Phase 2). Shim exposes the subscription but it only fires for sources the backend can resolve (AllManga). Movie/TV embed *download* is a known Phase-2 gap. |
| App version | `getAppVersion` | shim → `GET /api/version` |
| Block stats | `getBlockStats`, `onBlockedUpdate` | shim returns zeros; UI hides if web |
| Notifications | `showNotification` | web `Notification` API |
| External open | `openExternal` | `window.open` |
| Desktop chrome: titlebar, `windowMinimize/Maximize/Close/IsMaximized`, `getPlatform`, `setZoomFactor`, PiP window, `quitApp`, external player (`openPathAtTime`), folder pick, auto-updater (`detectUpdateFormat`, `downloadAndInstallUpdate`, `cancelUpdate`), scheduled backups | no-op / hidden via `window.__STREAMBERT_WEB__`; `getPlatform`→`"web"`; PiP → browser PiP where available |

## Frontend strategy — `window.electron` web shim

- `src/web/electron-shim.js` exports `installWebShim()`. It sets `window.__STREAMBERT_WEB__ = true`
  and, **only when `window.electron` is undefined** (i.e. not real Electron), assigns
  `window.electron = { …full IPC surface… }`.
- Wired from `src/main.jsx` **before** `<App/>` renders.
- Because the shim populates `window.electron`, `isElectron` stays true and existing feature
  paths (secure store, player, downloads) work through HTTP — **we do not rip out `isElectron`
  branches**. Truly desktop-only UI is hidden with a *separate* `window.__STREAMBERT_WEB__` flag
  (small, targeted edits; do not remove the Electron branch, add a web branch).
- All shim fetches use `credentials: "include"`.
- Event subscriptions (`onDownloadProgress`, `onM3u8Found`, …) are backed by a single WebSocket
  (`/api/events`) that the shim multiplexes into the `on*/off*` callbacks.

## Backend — Node + Fastify (`server/`)

- Serves the built frontend (`dist/`) as static + SPA fallback.
- Auth: `POST /api/login {password}` → signed HTTP-only cookie; `POST /api/logout`. Password from
  `STREAMBERT_PASSWORD` env. All `/api/*` except login require the cookie.
- Route modules (each agent owns one file, no cross-editing):
  - `server/routes/secure.js` — `GET/PUT /api/secure/:key` (server JSON store, single-user).
  - `server/routes/allmanga.js` — port of `src/ipc/allmanga.js` (`POST /resolve|/debug|/search`).
  - `server/routes/downloads.js` — port of `src/ipc/downloads.js` (queue, spawn downloader, progress via WS, `/api/files/*` range serving).
  - `server/routes/subtitles.js` — port of `src/ipc/subtitles.js` + `server/routes/wyzie.js`.
  - `server/routes/proxy.js` — stream proxy (Referer/Origin/UA spoof, CORS, Range passthrough).
  - `server/routes/meta.js` — `/api/version`, `/api/blockstats` (zeros).
- `server/events.js` — WS hub (`/api/events`) broadcasting `download-progress`, etc.
- Shared Node logic from `src/ipc/*` is copied into `server/lib/` and de-Electron-ified
  (`app.getPath`, `dialog`, `BrowserWindow`, `ipcMain` removed; paths from env/config).

## External binaries (Docker image must provide)

`ffmpeg`/`ffprobe`, the downloader CLI (`vid-dl-cli-only`) or an ffmpeg-based equivalent, and
`chromium` (for the Phase-2 extractor). Downloads land in a mounted data volume on Vision.

## Build & dev

- `vite build` already outputs a browser bundle (`base: "./"`); the Electron `main`/`preload`
  are simply not used by the web server. Add `npm run build:web` and `npm run serve` (start server).
- Dev: `vite` dev server + backend on another port with a `/api` proxy (`server.proxy` in a
  `vite.config.web.js` or an env-guarded block in the existing config).

## Deployment (Vision)

- `Dockerfile` (node:20-slim + ffmpeg + chromium + downloader) builds frontend, runs server.
- `docker-compose.yml` with **Caddy** for automatic HTTPS (iOS needs a secure context) reverse-
  proxying to the Node server; volume for `data/` (downloads + secure store).
- Reachability from devices (LAN / Tailscale / public) is a deploy-time choice; does not affect the build.
- **Deploy target (resolved):** Vision = `decps@10.10.54.19` (mgmt IP, eno1), Ubuntu 24.04.4 LTS,
  Dell R440, 72 cores / 250 GiB RAM, decps has sudo. SSH via the shared lab credential:
  `source ~/.lab_env` (loads `$SSHPASS`/`$LAB_USER=decps`), then `sshpass -e ssh decps@10.10.54.19`.
  Documented in `/home/philip/Projects/Tooling/README.md` + `tofino_25g_connectivity_map.md`.
  As of 2026-06-30 Vision has **no docker/node/ffmpeg installed** (install Docker first) and only
  **74 GB free on `/` (98 GB total)** — put the `data/` volume (downloads) on a larger mount or watch capacity.

## Subsystem ownership (agent map)

| Owner | Files | Expert skill |
|---|---|---|
| Orchestrator (me) | `docs/WEB_PORT.md`, `server/index.js`, `server/events.js`, `src/web/electron-shim.js`, vite web build | senior-fullstack / architect |
| Agent A | `server/routes/allmanga.js`, `server/lib/allmanga.js`, `server/routes/proxy.js` | senior-backend |
| Agent B | `server/routes/downloads.js`, `server/lib/downloads.js`, `/api/files` | senior-backend |
| Agent C | `server/routes/subtitles.js`, `server/routes/wyzie.js`, `server/lib/subtitles.js` | senior-backend |
| Agent D | frontend: player swap, `__STREAMBERT_WEB__` chrome hiding, secure-key wiring | frontend-design / senior-frontend |
| Agent E | `Dockerfile`, `docker-compose.yml`, `Caddyfile`, deploy to Vision | senior-devops |

## Phasing

- **Phase 1 (this build):** shim + backend (secure, allmanga, downloads, subtitles, proxy), embed
  playback for movie/TV, AllManga anime playback, library/settings (localStorage), auth, Docker+Caddy deploy.
- **Phase 2:** Playwright m3u8 extractor → ad-free in-app hls.js player + movie/TV downloads.
- **Phase 3:** cross-device library/progress sync (server-backed), multi-user.
