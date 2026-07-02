# Streambert Web Port — Handoff

_Last updated: 2026-07-01 (late — post Phase 2 deploy). Branch: `web-port` (local only — not pushed to any remote)._

This is the self-hostable **web port** of the Streambert Electron app. It runs as a
Fastify server + built React frontend, deployed on the **Vision** server.

---

## 1. Current state (all live + verified on `https://10.10.54.19`)

Three Docker containers on the user network `streambert-net`, all healthy:

| Container | Image | Role |
|---|---|---|
| `streambert-caddy` | `caddy:2-alpine` | TLS termination (LAN self-signed) + reverse proxy 80/443 → app |
| `streambert` | `streambert-web:latest` (repo root `Dockerfile`) | Fastify server + built React frontend, `:8787` |
| `streambert-extractor` | `streambert-extractor:latest` (`extractor/Dockerfile`) | **internal-only** headless-Chrome stream extractor, `:8788` (never published) |

- **URL:** `https://10.10.54.19` (LAN self-signed cert; install `caddy-root.crt` on devices to trust it).
- **Data:** `/home/decps/streambert-data` (bind-mounted `/data`): `streambert.db` (SQLite), `secure.json`, `downloads/`, `backups/`. Owned by host user `hugo` (uid 1000 = the container's `node` user).
- **Secrets:** `/home/decps/streambert/.env` (chmod 600): `STREAMBERT_PASSWORD`, `STREAMBERT_COOKIE_SECRET`, `STREAMBERT_TMDB_TOKEN`, `STREAMBERT_EXTRACTOR_URL=http://streambert-extractor:8788`. **Never overwrite it.**
- **TLS:** `Caddyfile.lan` on Vision = `10.10.54.19 { tls internal; encode gzip zstd; reverse_proxy streambert:8787 }` with a global `default_sni 10.10.54.19` (a bare-IP site needs it or the no-SNI handshake fails). Caddy root CA persisted in the `caddy_data` volume; exported copy at `/home/decps/streambert/caddy-root.crt`.
- **Daily DB backup:** decps crontab `17 4 * * *` runs `/home/decps/streambert-backup.sh` (in-container `better-sqlite3 .backup` → `/data/backups`, keeps 14).

Docker is only usable on **Vision** (as `decps`), not on the dev box. SSH: `decps@10.10.54.19` (keys in `/home/philip/Projects/Tooling/`).

---

## 2. Deploy procedure (raw `docker run` — NOT docker compose)

The repo has a `docker-compose.yml` + `Caddyfile`, but **the live deploy does not use them.** Use these steps.

### App (`streambert`)
```bash
# from repo root, on the dev box
rsync -az --exclude node_modules --exclude '.superpowers' server/ decps@10.10.54.19:/home/decps/streambert/server/
rsync -az --exclude node_modules src/                       decps@10.10.54.19:/home/decps/streambert/src/
rsync -az index.html                                        decps@10.10.54.19:/home/decps/streambert/index.html
ssh decps@10.10.54.19 'cd /home/decps/streambert && docker build -t streambert-web:latest .'
# recreate with rollback:
ssh decps@10.10.54.19 'bash -s' <<"EOF"
cd /home/decps/streambert
docker inspect streambert --format "{{range .Config.Env}}{{println .}}{{end}}" | grep -E "^(STREAMBERT_|PORT=)" > /tmp/sb.env; chmod 600 /tmp/sb.env
docker rm -f streambert_prev 2>/dev/null || true
docker rename streambert streambert_prev && docker stop streambert_prev
docker run -d --name streambert --restart unless-stopped --network streambert-net \
  -p 8787:8787 -v /home/decps/streambert-data:/data --env-file /tmp/sb.env \
  --log-opt max-size=10m --log-opt max-file=3 --memory=2g --memory-reservation=512m \
  streambert-web:latest
EOF
```
Rollback: `docker rm -f streambert && docker rename streambert_prev streambert && docker start streambert`.

### Extractor (`streambert-extractor`) — only when `extractor/` changes
```bash
rsync -az --exclude node_modules extractor/ decps@10.10.54.19:/home/decps/streambert/extractor/
ssh decps@10.10.54.19 'cd /home/decps/streambert/extractor && docker build -t streambert-extractor:latest .'
ssh decps@10.10.54.19 'docker rm -f streambert-extractor 2>/dev/null; \
  docker run -d --name streambert-extractor --restart unless-stopped --network streambert-net \
    --memory=1500m --log-opt max-size=10m --log-opt max-file=3 streambert-extractor:latest'
```

### Caddy (`streambert-caddy`) — rarely; reuse its volumes so the CA is preserved
`docker run -d --name streambert-caddy ... -v /home/decps/streambert/Caddyfile.lan:/etc/caddy/Caddyfile:ro -v caddy_data:/data -v caddy_config:/config -p 80:80 -p 443:443 -p 443:443/udp caddy:2-alpine`

### Verify a deploy
```bash
ssh decps@10.10.54.19 'docker ps --filter name=streambert --format "{{.Names}} {{.Status}}"; \
  curl -sk https://10.10.54.19/ -o /dev/null -w "https %{http_code}\n"; \
  docker exec streambert-extractor node -e "fetch(\"http://localhost:8788/health\").then(r=>r.text()).then(console.log)"'
```

Local builds/tests use nvm node 20 (`export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`) — the sandbox default `node` is a stale v10 that breaks `node:test`. Server tests: `node --test server/test/`. Frontend: `npm run build`.

---

## 3. VidSrc Direct — server-side stream extraction (the headline feature)

Plays movies/TV as a clean ad-free HLS stream extracted server-side instead of loading VidSrc's ad-laden embed iframe. Spec/plan: `docs/superpowers/{specs,plans}/2026-07-01-vidsrc-direct-extraction*`.

**Flow:** pick source `VidSrc Direct` → `POST /api/extract/vidsrc {tmdb,type,season?,episode?}` (session-gated, cached 3h) → app calls `streambert-extractor` → headless Chrome loads the VidSrc player, mints the token, sniffs the real `.m3u8` → `{url,referer}` → frontend plays via `WebMediaPlayer` (hls.js / native HLS) → **all segments proxied through `/api/proxy`** (which rewrites nested playlist URIs to same-origin `/api/proxy?url=…&referer=…`).

**Why the proxy matters:** the CDN stream JWT is **IP-bound** (`exp ~4h`, `ip_cidr` = the extractor's public /24). So every segment must be fetched server-side. The playlist rewrite (`server/lib/m3u8.js` `rewriteM3u8(body,base,referer)`) routes both hls.js (desktop/Android; its `ProxyLoader` no-ops on same-origin) **and iOS native HLS** (no loader hook) through the proxy.

**Upkeep treadmill:** VidSrc rotates its rcp host (`cloudorchestranova.com` at time of writing) and changes obfuscation. When extraction breaks, the fix is contained to `extractor/` — rebuild that image. Test live: `POST /api/extract/vidsrc {"tmdb":"550","type":"movie"}` should return `{url,referer}`.

**Key files:** `extractor/{extract,server}.js`, `server/routes/extract.js`, `server/lib/{m3u8,streamCache}.js`, `server/routes/proxy.js`, `src/utils/api.js` (source `vidsrc-direct`, `getSelectableSources`), `src/web/electron-shim.js` (`extractVidsrc`), `src/pages/{MoviePage,TVPage}.jsx` (resolver branch), `src/components/WebPlayer.jsx` (`WebMediaPlayer` + `ProxyLoader`).

---

## 4. Other recent work (all deployed)

- **Multi-user auth (Phase 1 + 2):** SQLite users, scrypt, signed-cookie sessions, admin Users panel. **Phase 2 (per-user server state) done:** watch progress/history/library/settings live in SQLite per user (`/api/state`, spec `docs/superpowers/specs/2026-07-01-per-user-server-state-design.md`) with localStorage as offline cache, one-time migration, and live cross-device sync over `/api/events`. Phase 3 (per-user downloads) NOT started.
  **Migration caveat:** the one-time localStorage import only runs while the account's server state is empty. If an account was used in several browsers before Phase 2, log in first from the browser with the most complete library — a later browser whose server state is already populated has its local cache overwritten by server truth (by design, so server-side deletions stay deleted).
- **Streaming sources:** VidSrc / Videasy / VidKing (iframe embeds) + AllManga (anime, direct HLS). Auto-failover when a source can't resolve a title (`src/utils/storage.js` failover cache).
- **Perf:** brotli/gzip compression, immutable asset caching, keep-alive agents (`proxy.js`, `allmanga.js`), TMDB preconnect, right-sized hero image.
- **Fullscreen** app-level button on the player (web had none — Electron webview events are a no-op on web).
- **Continue Watching** now includes embed-watched titles (embeds can't report progress; VidSrc Direct/AllManga do).
- **Mobile:** movie/TV detail hero reflows to a full-width column under 600px (was crushed into a ~50px strip).
- **Recommendations** home row from watch history; **autoplay** next episode; lowest-unwatched-season.

---

## 5. Known limitations / follow-ups (none blocking; from the final review)

- Extractor runs Chromium `--no-sandbox` **as root** (no `USER` in `extractor/Dockerfile`) — non-root would harden it.
- `/api/extract/vidsrc` collapses the extractor's 504 timeout to 502 (frontend fails over either way).
- App→extractor `fetch` has no explicit timeout (bounded in practice by the extractor's own 20s deadline).
- No route-level test for `/api/proxy` (only the pure `rewriteM3u8` is unit-tested).
- Extractor keeps a concurrency slot up to ~16s past a timeout (poll loop not aborted); immaterial at 2-slot/3h-cache load.
- iOS iframe embeds (non-Direct VidSrc/Videasy) can't go fullscreen — a platform limit; use VidSrc Direct (native `<video>`).
- Data dir + DB are `hugo`-owned, mode 775 (group/world readable); chowning needs sudo.

**iOS caveat:** headless testing can't exercise Safari's native-HLS engine, so a real iPhone is the definitive test for VidSrc Direct playback.

---

## 6. Outstanding

- `web-port` is **local only** — not pushed. Remotes are pre-wired for the chosen destination: `origin` → `git@github.com:akekulip/streambert.git` (**repo not created yet** — create it private+empty on github.com, then push `main`, `multiuser-p1`, `web-port`, `autoresearch/engineering/recs-engine-v2`); `upstream` → truelockmc/streambert (no push access).
- SDD progress ledger + task briefs (VidSrc Direct + Phase 2 builds) live in `.superpowers/sdd/` (git-ignored scratch).
- **Phase 2 deployed 2026-07-01 ~23:54** (image `cc211886a382`; rollback container `streambert_prev` kept on Vision). Live-verified server-side: all 5 tables migrated, throwaway-user e2e passed (login / me-with-id / all state writes incl. text/plain beacon / bootstrap round-trip / cascade delete). Post-deploy backup taken + verified (`backups/streambert-2026-07-01-23-56-25.db`).
- **Recs engine v2 deployed 2026-07-02** (image `b28716ac1ba5`; rollback container `streambert_prev` kept on Vision). Autoresearch winner (hybrid: newest-seed top-8 verbatim + consensus tail; branch `autoresearch/engineering/recs-engine-v2`, row_score 0.8800). New: `/api/recommendations` (session-gated, per-user SQL history, cache busted on history writes), HomePage consumes it with legacy client-side fallback, admin `/api/admin/{stats, users/:id/summary, users/:id/recommendations, recs-cache/purge}` + UsersAdminPanel server card/user details. Live-verified: container healthy, https 200, routes 401-gated, in-container engine smoke vs live TMDB returned a sane 20-item row. 59/59 server tests. Experiment eval harness + real-user harvest: `eval/recs/` (`node eval/recs/harvest_real.mjs` once users migrate).
- **TMDB cache + stream pre-warming deployed 2026-07-02** (image `417180cac837`, rollback `streambert_prev`; roadmap item ① core). `/api/tmdb/*` session-gated proxy over the shared `lib/tmdb.js` cache (lists 30m TTL, details 6h; live-measured cold 128ms → warm 0ms); web client `tmdbFetch` prefers it and latches direct mode on 404/401 (desktop/legacy). Extraction hoisted to `lib/extract.js` (shared cache with `/api/extract`); `lib/prewarm.js` pre-extracts resume points + imminent next episodes (pct≥85, season rollover) + top recs on bootstrap — serial, 6-job cap, 30min/user cooldown, `STREAMBERT_PREWARM=0` kill switch. Admin stats show TMDB hit rate / cached streams / pre-warm counters. 69/69 server tests.
- **Analytics + admin dashboard + canary deployed 2026-07-02** (image `27842af602d1`, rollback `streambert_prev`; roadmap item ③). New `watch_events` append-only log (written by addHistory, cleared with history, migration-seeded once — prod seeded 2 rows, so real watches have begun landing). Admin endpoints: `GET /api/admin/analytics?days=7..90` (watches/day, top titles, most active, movie/tv split), `GET /api/admin/health` + `POST /api/admin/health/canary`. Hourly extraction canary (tmdb 550, cache-bypassed; `STREAMBERT_CANARY=0` disables) — target extraction live-verified passing. `AdminDashboard.jsx` renders it all in Settings→Admin. 74/74 server tests.
- **Custom native player controls deployed 2026-07-02** (image `9179798493b7`, rollback `streambert_prev`; post-deploy backup `streambert-2026-07-02-16-23-08.db`). Web build only, no schema change. App-styled control bar on the native `<video>` player (VidSrc Direct + AllManga via `WebMediaPlayer`): scrub/play/seek/volume/speed/**working fullscreen**/CC + resume + per-user progress + keyboard shortcuts + auto-hide. Web non-anime default flipped to `vidsrc-direct` (`getDefaultNonAnimeSource()`; desktop stays `vidsrc`); iframe embeds untouched. New `GET /api/subtitles/vtt` serves browser-parseable WebVTT (SRT→VTT) — live-verified in-container (`srtToVtt` header+dot-timestamps ok, route 401-gated). Pure player logic under `src/components/player/*.mjs` (node --test). Spec/plan/ledger: `docs/superpowers/{specs,plans}/2026-07-02-native-player-controls.*`, `.superpowers/sdd/progress.md`. 77/77 server tests, 17/17 player tests, build green. **Human check pending:** manual browser pass (controls/fullscreen/resume/subtitles/shortcuts on a real title).
- **Videasy set as web default + AdGuard Videasy allowlist 2026-07-02** (image `50e25d276b82`, rollback `streambert_prev`). `getDefaultNonAnimeSource()` web now returns `videasy` (was `vidsrc-direct`); native player stays selectable. AdGuard was nulling `users.videasy.to`→0.0.0.0 (rule from `filters/3.txt`), which breaks Videasy's client-side player while VidSrc Direct is unaffected (server-extracted+proxied). Added `user_rules: ['@@||videasy.to^']` to `AdGuardHome.yaml` (backup `.bak`), restarted adguardhome — `users.videasy.to` now resolves real IPs. CAVEAT: only helps clients that actually use AdGuard (10.10.54.19:53) as DNS; the user reported VidSrc ads leaking + doubts AdGuard is in-path, so the real block may be a client-side browser ad-blocker/device DNS. If Videasy still fails, need the browser Network tab to find any other blocked CDN domain.
- **Human check still pending:** two browsers as the same user — library add / progress update should live-sync (WS `state-changed`); also a real-browser migration pass (seed localStorage, log in fresh). Once migrated histories exist, run the recs harvest (above) so `real_row_score` becomes a second eval signal.
- **Improvement roadmap (session decisions, 2026-07-01):** scale target ~10–100 users (single process + SQLite stays). Queue after Phase 2: ① TMDB server-side cache + perf hardening → ② recommendation engine v2 (now unblocked by server-side history) → ③ analytics + admin dashboard → Phase 3 (per-user downloads). Off-box backup copy is a nice-to-have.
