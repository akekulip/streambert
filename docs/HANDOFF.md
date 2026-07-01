# Streambert Web Port — Handoff

_Last updated: 2026-07-01. Branch: `web-port` (local only — not pushed to any remote)._

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

- `web-port` is **local only** — not pushed. Push / open a PR when ready.
- SDD progress ledger + task briefs for the VidSrc Direct build live in `.superpowers/sdd/` (git-ignored scratch).
