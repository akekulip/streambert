# VidSrc Direct — server-side stream extraction design

**Status:** Approved design → ready for implementation plan.

**Goal:** Add a "VidSrc Direct" playback source that plays movies and TV episodes as a clean, ad-free, mixed-content-proof HLS stream — by extracting the real stream server-side (headless Chrome) instead of loading VidSrc's ad-laden embed in an iframe. This closes the Electron-vs-web playback gap for VidSrc.

**Architecture:** A new internal `streambert-extractor` sidecar (Node + puppeteer-core + Chromium) loads the VidSrc player, lets its JS mint the required token, and sniffs the real `.m3u8`. The `streambert` app calls it via a cached route and plays the result through the existing hls.js + `/api/proxy` path (the same machinery AllManga uses). The app image stays browser-less.

**Tech stack:** Node 20, Fastify (app), puppeteer-core + Chromium (extractor), hls.js (frontend, already present), Docker raw `docker run` on `streambert-net`.

## Background — proven feasibility (spike)

A prototype (`scratchpad/vidsrc-extract.js`, `headless-vidsrc.js`, findings doc) established:

- **Chain:** `GET vidsrc.me/embed/{type}/{id}[/{s}/{e}]` → player iframe `//<rcpHost>/rcp/{hash}` (rcpHost rotates; currently `cloudorchestranova.com`) → rcp page contains `src: '/prorcp/{id}'` → prorcp page's `Playerjs({file: master_urls})` yields `https://<cdn>/pl/{gzip}/master.m3u8?token=__TOKEN__`.
- **Static fetch fails:** the `__TOKEN__` is minted client-side; raw fetch → `403 invalid token`.
- **Headless interception works:** loading the rcp URL in headless Chrome and sniffing the `*.m3u8` request yields a valid, playable master manifest (`HTTP 200`, `#EXTM3U`, multi-bitrate up to 1920×800).
- **Decisive constraint — the stream JWT is IP-bound:** claims decode to `{exp: ~4h after issue, ip_cidr: "<minting-subnet>/24"}`. The token is valid only for fetches from the /24 subnet that minted it. Therefore the **server must both extract and proxy** the stream; the browser must never fetch the CDN directly. This aligns with the existing `/api/proxy` design.
- **Variant URLs are absolute paths** (`/pl/…`) on the CDN. hls.js resolves those against the page origin, not the CDN, so the proxy must rewrite playlists to absolute CDN URLs (see Component 3).

## Global Constraints

- The extractor container is **internal only** — bound to `streambert-net`, never published to the host.
- The `streambert` app image must remain **browser-less** (no Chromium, no puppeteer). All browser code lives in the extractor.
- Cache TTL for an extracted stream is **3 hours** (strictly less than the ~4h token `exp`).
- `/api/extract/vidsrc` is **session-gated**, like other app API routes.
- VidSrc's `rcpHost` rotates; the extractor must read it **dynamically** from the embed page, never hard-code it.
- Deployment stays **raw `docker run`** on `streambert-net` (no compose). Caddy container is untouched.

## Components

### 1. Extractor service — `extractor/` (new)

Self-contained Node service; owns all VidSrc-specific scraping and the only puppeteer/Chromium in the system.

- **Files:** `extractor/server.js` (HTTP + orchestration), `extractor/extract.js` (chain + interception logic, hardened from the spike), `extractor/package.json`, `extractor/Dockerfile`.
- **Endpoint:** `POST /extract`, body `{ tmdb: string, type: "movie"|"tv", season?: number, episode?: number }`.
  - Success → `200 { m3u8: string, referer: string }` (referer = `https://<cdnHost>/`).
  - No stream found → `404 { error: "no stream" }`.
  - Timeout → `504 { error: "extract timeout" }`.
- **Endpoint:** `GET /health` → `200 { ok: true }`.
- **Behavior:** builds the embed URL (`/embed/movie/{id}` or `/embed/tv/{id}/{season}/{episode}`), fetches the embed (plain HTTPS) to get the rcp URL, navigates headless Chrome to the rcp URL with `Referer: https://vidsrc.me/`, **triggers playback** (launch with `--autoplay-policy=no-user-gesture-required` and click the player/frames) so the player mints the token and requests the stream, intercepts the first request matching `/\.m3u8/` that does not contain `__TOKEN__`, returns its URL + the CDN referer. (Both behaviors are proven in the spike's `headless-vidsrc.js`.)
- **Chrome lifecycle:** launch one browser instance at startup, reuse it; one fresh incognito context per request, closed after. Relaunch on browser disconnect/crash.
- **Concurrency + timeout:** a semaphore caps to **2** concurrent contexts; further requests queue. Per-request hard timeout **20s** → close context, return `504`.
- **Env:** `PORT` (default 8788).

### 2. App extract route + cache — `server/routes/extract.js` (new)

- **Endpoint:** `POST /api/extract/vidsrc`, body `{ tmdb, type, season?, episode? }`, session-gated.
- **Cache:** in-memory `Map`, key `${type}:${tmdb}:${season||0}:${episode||0}`, value `{ url, referer, ts }`, TTL 3h. In-memory only — IP+time-bound tokens have no value persisted across restarts. Cap size (e.g. 500) with oldest-eviction.
- **On miss:** `POST ${EXTRACTOR_URL}/extract`. Map extractor `200`→`{ url, referer }` (cache + return), `404`→`404 { error }`, `504`→`504`, connection error→`503 { error: "extractor unavailable" }`.
- **Env:** `STREAMBERT_EXTRACTOR_URL` (e.g. `http://streambert-extractor:8788`).

### 3. Proxy m3u8 rewrite — `server/routes/proxy.js` (modify)

Currently streams the upstream body unchanged. Add: if the upstream response is an HLS playlist (content-type `application/vnd.apple.mpegurl` / `application/x-mpegURL`, or body begins `#EXTM3U`), **buffer** it (playlists are small), rewrite every non-comment URI line to an **absolute URL resolved against the upstream request URL**, and send the rewritten body. Segment responses (`.ts`/`.m4s`/`.mp4`) continue to stream unchanged. With absolute CDN URLs in the playlist, the existing hls.js `ProxyLoader` re-proxies each nested request with the same spoofed referer, from the server IP (so the JWT validates). This also benefits any other HLS source with relative/rooted URIs.

### 4. Frontend source + wiring — `src/utils/api.js`, `src/web/electron-shim.js`, `src/pages/{MoviePage,TVPage}.jsx` (modify)

- **`api.js`:** add source `{ id: "vidsrc-direct", label: "VidSrc Direct", async: true, resolver: "vidsrc" }`. Existing AllManga source gets `resolver: "allmanga"` (or defaults to allmanga when unset). `sourceIsAsync` stays true for both.
- **Shim:** add `extractVidsrc({tmdb,type,season,episode})` → `POST /api/extract/vidsrc` (mirrors `resolveAllManga`).
- **Movie/TVPage resolve effect:** branch on `source.resolver`. `"vidsrc"` → `extractVidsrc(...)` → on `{url,referer}` `setWebMedia({ url, referer, startTime })` (existing `WebMediaPlayer` renders); `"allmanga"` → existing path. On failure → existing `resolveError` + the existing auto-failover.
- No change to `WebMediaPlayer` — it already proxies + plays HLS.

### 5. Deployment — new container + docs (modify)

- New container `streambert-extractor`: built from `extractor/Dockerfile`, run on `--network streambert-net`, **not** port-published, `--restart unless-stopped`, `--memory=1500m`, log-rotation (`max-size=10m max-file=3`).
- `streambert` app run gains `-e STREAMBERT_EXTRACTOR_URL=http://streambert-extractor:8788`.
- Update the project-memory deploy note + `docs/DEPLOY.md` to describe the three-container topology (caddy + app + extractor).

## Data flow

`pick "VidSrc Direct"` → `POST /api/extract/vidsrc` → app cache miss → `POST extractor/extract` → Chrome loads rcp, mints token, sniffs `.m3u8` → `{m3u8,referer}` → app caches (3h) + returns `{url,referer}` → frontend `setWebMedia` → `WebMediaPlayer` → hls.js `ProxyLoader` → `/api/proxy` (rewrites master to absolute CDN URLs, re-proxies variants + segments from Vision's IP so the JWT validates) → video plays.

## Error handling

- Extractor timeout / no m3u8 → app `504`/`404` → frontend shows the same "not found on this source" state as an AllManga miss, and the existing auto-failover may hand off to another source.
- Extractor container down → app `503` → same frontend fallback. Never crashes the app.
- Chrome crash inside the extractor → caught, browser relaunched, that request returns `504`.
- Token expiry mid-playback (rare, >3h sessions) → segment `403` surfaces as a playback stall; a retry re-extracts (cache expired). Acceptable for v1.

## Testing

- **Extractor `extract.js`:** unit-test the chain parsers (embed→rcp, rcp→prorcp) against saved HTML fixtures. A live smoke test (`type=movie tmdb=550`) gated behind `EXTRACTOR_LIVE_TEST=1` (network-dependent, not in CI default).
- **App route:** mock the extractor HTTP call; assert cache miss→call→cache, cache hit→no call, TTL expiry→re-call, and error mapping (404/504/503).
- **Proxy rewrite:** unit-test with a sample master playlist containing absolute-path and relative URIs → assert all become absolute CDN URLs; assert non-playlist bodies pass through untouched.
- **Frontend:** render test — the "VidSrc Direct" source appears in the picker and, on select for a movie, calls `extractVidsrc` and mounts `WebMediaPlayer` (mock the shim).

## Out of scope (future)

- Other providers (Videasy, VidKing) — same pattern, separate follow-ups.
- Static token reverse-engineering (fragile; headless is the chosen path).
- Persistent/shared cache across restarts.
- Subtitle extraction from VidSrc.

## Risks

- **Upkeep treadmill:** VidSrc rotates `rcpHost` and changes obfuscation; the extractor's parse/intercept flow will periodically break and need maintenance. Contained to `extractor/`.
- **Anti-bot:** headless worked in the spike; VidSrc may later require headful/xvfb or stealth. Contained to the extractor image.
- **Resource use:** Chrome is memory-heavy; the 2-context cap + 1.5G mem limit bound it. Extraction adds ~10–15s latency on a cache miss (acceptable, one-time per title per 3h).
