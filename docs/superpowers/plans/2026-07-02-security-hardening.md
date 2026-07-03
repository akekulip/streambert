# Public-Launch Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the 8 Critical + 4 Important findings from `docs/superpowers/audits/2026-07-02-prelaunch-security-audit.md` so Streambert can be exposed to the public internet at xtreamz.org.

**Architecture:** Add one shared SSRF guard used by every "fetch a client-named URL" sink; reuse the existing `isPathInside()` for the un-guarded subtitle file ops; add role gates, security headers, a scoped `trustProxy`, a fail-fast cookie secret, an env flag for `/vzy`, per-user scoping/caps, and an iframe sandbox. Each fix is independent.

**Tech Stack:** Fastify + better-sqlite3 + `node:test` (server); React (Vite) verified by `vite build`.

## Global Constraints
- **Node:** default `node` is v10; prefix every command with `export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"`. Server tests from `server/`: `node --test test/`.
- **No new npm deps** unless unavoidable (prefer stdlib `net`/`dns` and a Fastify hook over helmet).
- Preserve all existing passing tests (currently 92/92). Client verified by `vite build`.
- Commit style: Conventional Commits + repo `Co-Authored-By: Claude Fable 5` / `Claude-Session` trailers.
- Findings reference the audit doc by ID (C1–C8, I1–I4).

---

## Task 1 (C1) — shared SSRF guard on every server-side URL fetch
**Files:** Create `server/lib/safeUrl.js` (+ `server/test/safeUrl.test.js`); Modify `server/routes/proxy.js`, `server/lib/subtitles.js`, `server/lib/allmanga.js`, `server/routes/allmanga.js`.

**Produces:** `assertPublicHttpUrl(rawUrl) -> URL` (throws `{code:'BLOCKED_URL'}` for non-http(s), or a host that resolves to / is a literal private/loopback/link-local/ULA address, or a bare hostname ending in `.internal`/`.local`/a docker service name pattern). Also `isBlockedHost(hostname)->bool`.

- [ ] **Step 1: failing test** `server/test/safeUrl.test.js`:
```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isBlockedHost, assertPublicHttpUrl } = require("../lib/safeUrl");
test("blocks loopback / private / link-local / internal literals + names", () => {
  for (const h of ["127.0.0.1","0.0.0.0","::1","169.254.169.254","10.0.0.5","192.168.1.1","172.16.0.9","localhost","streambert-extractor","foo.internal","bar.local"])
    assert.equal(isBlockedHost(h), true, h);
});
test("allows normal public hosts", () => {
  for (const h of ["dl.subdl.com","player.videasy.to","example.com","1.1.1.1"])
    assert.equal(isBlockedHost(h), false, h);
});
test("assertPublicHttpUrl throws BLOCKED_URL for non-http and private", () => {
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), (e)=>e.code==="BLOCKED_URL");
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/x"), (e)=>e.code==="BLOCKED_URL");
  assert.throws(() => assertPublicHttpUrl("https://dl.subdl.com@169.254.169.254/x"), (e)=>e.code==="BLOCKED_URL");
  assert.equal(assertPublicHttpUrl("https://dl.subdl.com/a").hostname, "dl.subdl.com");
});
```
- [ ] **Step 2: run → fail** (`cd server && node --test test/safeUrl.test.js`).
- [ ] **Step 3: implement `server/lib/safeUrl.js`:**
```js
"use strict";
// Guard for every server-side fetch of a client-named URL (SSRF defense).
function isBlockedHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // bare single-label hostnames (docker service names like "streambert-extractor")
  if (!h.includes(".") && !h.includes(":")) return true;
  // IPv4 literal ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a,b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;           // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
    if (a === 192 && b === 168) return true;           // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 loopback / ULA / link-local
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}
function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { const e = new Error("invalid url"); e.code = "BLOCKED_URL"; throw e; }
  if (u.protocol !== "http:" && u.protocol !== "https:") { const e = new Error("blocked protocol"); e.code = "BLOCKED_URL"; throw e; }
  if (isBlockedHost(u.hostname)) { const e = new Error("blocked host"); e.code = "BLOCKED_URL"; throw e; }
  return u;
}
module.exports = { isBlockedHost, assertPublicHttpUrl };
```
- [ ] **Step 4: wire it into every sink.** Read each file, then:
  - `server/routes/proxy.js`: after parsing `url`, call `assertPublicHttpUrl(url)` before the fetch; on throw → `reply.code(400).send({error:"blocked url"})`. ALSO re-check each redirect `Location` (the proxy follows redirects server-side) with `assertPublicHttpUrl` before following — a public URL can 302 to an internal one.
  - `server/lib/subtitles.js`: in `getSubtitleVtt` (wyzie branch), `downloadSubtitlesForFile` (direct_url/wyzie branch), and every `` `https://dl.subdl.com${subdlPath}` `` concat: build via `assertPublicHttpUrl(...)`. For the subdl concat, construct `new URL(subdlPath, "https://dl.subdl.com")` and assert the resulting `.hostname === "dl.subdl.com"` (reject otherwise) — this kills the `@host` userinfo bypass.
  - `server/lib/allmanga.js`: `hlsManifest`/`fetchM3u8` (`/api/allmanga/hls`) → `assertPublicHttpUrl` before fetch.
  - `server/routes/allmanga.js`: **remove the `POST /debug` route** (it's a raw SSRF/response-reflection oracle); also remove `lib/allmanga.js`'s `debug()` export/usage if now unused (leave the function if other code calls it — grep first).
- [ ] **Step 5: run** `cd server && node --test test/` → all pass (existing subtitle/proxy tests may need the guard to allow their public test URLs — they use `yoru.shegu.org`/`dl.subdl.com`, which pass).
- [ ] **Step 6: commit** `git commit -m "fix(sec): SSRF guard on all server-side URL fetches; drop allmanga debug oracle (C1)"`

## Task 2 (C2) — file-path containment on subtitle write/delete
**Files:** Modify `server/lib/subtitles.js`; Test `server/test/subtitles.test.js`.
**Consumes:** the existing `isPathInside`/`isSubpath` helper from `server/lib/downloads.js` (export it if not already, or add a small local one).
- [ ] Read `server/lib/downloads.js` for the containment helper; export it (e.g. `module.exports.isPathInside`).
- [ ] In `subtitles.js`: `deleteSubtitleFile({subtitlePath})` must verify `isPathInside(subtitlePath, <DATA_DIR>/subtitles)` (and the downloads dir) before `fs.unlinkSync` — else throw. `downloadSubtitlesForFile({filePath})` must verify the derived `dir` is inside the downloads dir before `fs.writeFileSync`. Strip `../` and leading `/` from the ZIP entry `fileName` before `path.join` (zip-slip).
- [ ] Test: `deleteSubtitleFile({subtitlePath:"/etc/passwd"})` throws / does not unlink; a path inside the subtitles dir works; a ZIP entry named `../../evil` stays contained.
- [ ] `cd server && node --test test/` green. Commit `fix(sec): contain subtitle file write/delete/zip-slip (C2)`.

## Task 3 (C3) — remove `file:` local-read AND SSRF-guard the download-subtitle fetch
**Files:** Modify `server/lib/downloads.js`; Test `server/test/` (add).
The Task-1 SSRF re-review found `downloadSubtitleFile` (`downloads.js:44-56`) is BOTH an arbitrary local-file read (`file:` branch) AND an unguarded SSRF (it fetches an arbitrary client-supplied http(s) URL via `https.get`/`http.get`, following redirects with no validation). Fix both:
- [ ] Remove the `if (parsedUrl.protocol === "file:")` branch entirely (subtitles come from http(s) providers) — kills the arbitrary local-file read (`file:///data/streambert.db` etc.).
- [ ] Route the remaining http(s) fetch through the SSRF-safe path built in Task 1: `const { safeFetch } = require("./safeUrl")` and replace the raw `https.get`/`http.get` (with its own redirect recursion) with `safeFetch(url, {}, ms)` (which validates each hop by string + resolved IP and caps redirects). Adapt the response handling to `safeFetch`'s `fetch`-style Response (`res.ok`, `res.arrayBuffer()`/`res.body`) — read the current function first to preserve its copy-to-`destPath` behavior; `destPath` stays confined as before.
- [ ] Test: a `file://` subtitle url is rejected/skipped (no copy); a client URL that resolves to a private/loopback IP is rejected (reuse the `safeUrl` guard — assert `downloadSubtitleFile` rejects `http://127.0.0.1/x`). Keep tests deterministic (literal private IP, no external DNS).
- [ ] `cd server && node --test test/` green. Commit `fix(sec): drop file:// read + SSRF-guard download-subtitle fetch (C3)`.

## Task 4 (C4) — admin-gate the shared secret store
**Files:** Modify `server/routes/secure.js`; Test `server/test/` (add or in admin.test.js).
- [ ] Add a per-route guard: `PUT /:key` requires `req.user?.role === "admin"` (else 403). For `GET /:key`: keep it working for the app, but only an admin gets the raw value; a non-admin gets `{ value: null }` for sensitive keys (or gate GET to admin too and confirm the client still boots — check `src/App.jsx` TMDB flow; if the web client needs `apikey`, prefer routing TMDB through the existing `/api/tmdb` proxy which already uses the server-side token, so the browser never needs `/api/secure/apikey`). Simplest safe first step: **admin-gate both GET and PUT**, then verify the web app's TMDB still works via `/api/tmdb` (it does — `src/utils/api.js` prefers the proxy). If boot breaks, gate PUT only and leave GET, and open a follow-up to remove the client token dependency.
- [ ] Test: non-admin `PUT /api/secure/apikey` → 403; admin → 200.
- [ ] `node --test test/` green. Commit `fix(sec): admin-gate /api/secure token store (C4)`.

## Task 5 (C7 + C8) — scoped trustProxy + fail-fast cookie secret
**Files:** Modify `server/app.js`, `server/index.js`; Test `server/test/` (add).
- [ ] `server/app.js`: change `trustProxy: true` to a bounded value. Behind Caddy→app (one hop) and cloudflared, use `trustProxy: 1` (trust exactly one proxy hop) so `req.ip` is the address Caddy saw, not a client-forged leftmost XFF. (Document: re-verify hop count once the tunnel is live; if cloudflared+Caddy = 2 hops to the app, use 2.)
- [ ] `server/index.js`: replace the `|| "streambert-dev-secret-change-me"` fallback with a fail-fast: if `!process.env.STREAMBERT_COOKIE_SECRET` OR it equals the dev sentinel, `console.error(...)` + `process.exit(1)` (allow a test bypass only when `NODE_ENV==='test'`). Never sign real sessions with a source-visible secret.
- [ ] Test: (unit) the secret-check helper rejects the dev default / empty. Commit `fix(sec): scope trustProxy to one hop; fail-fast cookie secret (C7,C8)`.

## Task 6 (I2) — baseline security headers
**Files:** Modify `server/app.js` (an `onSend` hook); Test `server/test/` (add).
- [ ] Add a Fastify `onSend`/`onRequest` hook that sets on every response: `Content-Security-Policy: frame-ancestors 'none'` (anti-clickjacking; keep it minimal to avoid breaking the app — do NOT add a restrictive default-src that breaks the SPA/iframes; start with `frame-ancestors 'none'` only), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. NOTE: do NOT apply `frame-ancestors`/`X-Frame-Options` to the `/vzy/*` responses (those are meant to be framed by the app) — skip the header there.
- [ ] Test: a normal response carries `x-frame-options: DENY` + `x-content-type-options: nosniff`; a `/vzy` response does not carry X-Frame-Options. Commit `fix(sec): baseline security headers (I2)`.

## Task 7 (C5) — gate /vzy behind an env flag (off for public)
**Files:** Modify `server/app.js` (route registration), `src/utils/api.js` (only proxy Videasy when enabled); Test `server/test/` (add).
- [ ] `server/app.js`: only `tryRegister("./routes/vzy", {prefix:"/vzy"})` when `process.env.STREAMBERT_VZY === "1"`. When off, `/vzy/*` falls through to the SPA/404 (the preHandler still gates it, but the route won't proxy).
- [ ] `src/utils/api.js` `getSourceUrl`: only rewrite Videasy → `/vzy/p` when a runtime flag says the proxy is available. Simplest: expose the flag via `/api/config` (add `vzy: <bool>` from `process.env.STREAMBERT_VZY === "1"`) and have the client read it once; OR keep the rewrite but if `/vzy` isn't registered the embed just fails to the existing fallback. Minimal safe approach: keep the client rewrite, but since `/vzy` is unregistered in public, Videasy simply won't load (acceptable — VidSrc Direct is default). Prefer wiring the `/api/config` `vzy` flag so the client only offers/uses Videasy-via-proxy when enabled.
- [ ] Test: with `STREAMBERT_VZY` unset, `GET /vzy/p/movie/550` is NOT proxied (404/SPA, not a videasy fetch); with `="1"` it registers. Commit `fix(sec): gate /vzy behind STREAMBERT_VZY flag, off by default (C5)`.

## Task 8 (C6) — sandbox the embed iframe
**Files:** Modify `src/components/WebPlayer.jsx`.
- [ ] Add a `sandbox` attribute to `WebEmbedPlayer`'s `<iframe>`: `sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"` (NOT `allow-top-navigation` / `allow-popups`) to block `top.location` hijack + popunders. Keep a code comment: some providers detect the sandbox attribute — if a specific provider breaks, this is the documented tradeoff; test per-provider in the manual pass. Build green. Commit `fix(sec): sandbox embed iframe to block top-nav hijack (C6)`.

## Task 9 (I1) — scope downloads per-user + cap spawns
**Files:** Modify `server/routes/downloads.js`, `server/lib/downloads.js`; Test `server/test/` (add).
- [ ] Scope the registry read/mutations by `req.user.id` (like `server/routes/state.js`): `GET /` returns only the caller's downloads; `POST /delete`, `/delete-all`, `/file-exists`, `/duration` verify the target belongs to the caller (or require `req.user.role==='admin'` for cross-user). Add a global concurrent-`vid-dl`-spawn cap (e.g. a module-level counter, max 2) — reject `POST /` with 429 when full. (If downloads store no user_id today, add a `user_id` field to the download record on create and filter by it; check `lib/downloads.js` registry shape first.)
- [ ] Test: user A cannot see/delete user B's download; a spawn cap rejects the (N+1)th. Commit `fix(sec): scope downloads per-user + cap concurrent spawns (I1)`.

## Task 10 (I3 + I4) — extractor per-user cap + username-scoped login throttle
**Files:** Modify `server/routes/extract.js`, `server/routes/auth.js` (+ maybe `server/lib/loginThrottle.js`); Test `server/test/`.
- [ ] `server/routes/extract.js`: add a per-user in-flight cap (e.g. max 1 concurrent extraction per `req.user.id`) so one account can't monopolize both extractor slots; return 429 when the user already has one in flight.
- [ ] Login throttle: add a second, IP-independent counter keyed on username only, with a higher threshold + longer cooldown (e.g. 20 failures / 15 min across all IPs → account-scoped cooldown), so distributed brute-force on `admin` is bounded even with per-IP buckets. Wire it in `auth.js` alongside the existing per-`(user,ip)` check.
- [ ] Tests: a user's 2nd concurrent extract → 429; N username-failures across different IPs → locked. Commit `fix(sec): per-user extract cap + username-scoped login throttle (I3,I4)`.

---

## Notes for the implementer
- Do NOT weaken the registration/approval gate (it audited clean).
- After all tasks: run the FULL server suite + `vite build`; both must be green. A final whole-branch security re-review confirms the audit's Criticals are closed.
- Deployment still requires: verify `STREAMBERT_COOKIE_SECRET` set on Vision; confirm extractor port not routed publicly; set `trustProxy` hop count once the Cloudflare Tunnel topology is final.
