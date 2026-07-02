# Streambert Pre-Launch Security Audit — 2026-07-02

**Context:** the app is about to go **public on the internet** (`xtreamz.org` via Cloudflare Tunnel) with **self-registration + admin approval**. This audit was run by three parallel security reviewers (auth/session, injection/SSRF, exposure/secrets/XSS/DoS) plus an automated feature/functional test. Every Critical/Important finding below was verified against the actual source (file:line confirmed).

## Bottom line

**Functionally: green.** Server suite 92/92, extractor 5/5, player logic 17/17, client build ✓, live prod 401s every protected endpoint. The new registration/approval feature is well-built (exact-path gate, admin role guard, no mass-assignment, constant-time login, immediate session revocation, SameSite=Lax).

**Security: NOT READY to expose publicly as-is.** Root cause is uniform — dozens of endpoints assume "active user = someone the admin personally created and trusts." Public self-registration makes "active user" = any member of the public the admin clicked *Activate* once. Every one of the SSRF / arbitrary-file / shared-secret bugs below is gated only by "has an active account."

**Do NOT open the Cloudflare Tunnel to the public until the CRITICAL list is fixed.**

---

## CRITICAL — fix before ANY public exposure

### C1. Server-side SSRF in every "fetch a client-named URL" sink (no host allowlist)
Multiple endpoints fetch an attacker-controlled URL server-side and reflect the response:
- `GET /api/proxy?url=` — `server/routes/proxy.js:117-122`: only checks `http:`/`https:`, no host check; follows redirects. Reaches `http://127.0.0.1:*`, `http://169.254.169.254/…` (cloud metadata), `http://streambert-extractor:8788`, and the Vision LAN.
- `GET /api/subtitles/vtt?fileId=wyzie_…` — `server/lib/subtitles.js:351,413`: decodes a URL from `fileId`, **no scheme/host restriction at all** (plain `http://` allowed), returns the body.
- SubDL branch userinfo-injection — `subtitles.js:264,333-349,390` build `` `https://dl.subdl.com${subdlPath}` `` by string concat; `subdlPath="@evil.example/x"` → host `evil.example` (classic `trusted@attacker` bypass). Duplicated 3×.
- `POST /api/allmanga/debug {path}` — `server/lib/allmanga.js:822-829`: raw SSRF oracle, reflects 3000 chars. Reads like a leftover debug endpoint.
- `GET /api/allmanga/hls?url=` — same protocol-only, host-unchecked pattern.
**Fix:** a shared guard on every such sink — block RFC1918 / loopback / link-local / `.internal` Docker names; delete or admin-lock `/api/allmanga/debug`; replace `https://dl.subdl.com${subdlPath}` with `new URL(subdlPath, "https://dl.subdl.com")` + explicit host-equality.

### C2. Arbitrary file write & delete via subtitle endpoints (missing containment)
`server/lib/subtitles.js` skips the `isPathInside()` guard used everywhere else:
- **Delete** — `deleteSubtitleFile()` `subtitles.js:469`: `fs.unlinkSync(subtitlePath)` on any client-supplied path → delete `streambert.db`, `.env`, other users' files.
- **Write** — `downloadSubtitlesForFile()` `subtitles.js:377,427`: `path.dirname(filePath)` from the body + `fs.writeFileSync(destPath, attackerContent)` → write attacker content to any directory (ext constrained to srt/vtt/ass/ssa).
- **Zip-slip** (Minor, chainable) — SubDL ZIP entry name joined without stripping `../` (`subtitles.js:276-282`).
**Fix:** reuse `isPathInside()` (from `lib/downloads.js`) in `deleteSubtitleFile` and `downloadSubtitlesForFile`; strip `../` from ZIP entry names.

### C3. Arbitrary local file read via `file://` download subtitle
`server/lib/downloads.js:44-56` (`downloadSubtitleFile`) honors `file:` on a client-named `subtitles[].url`, copying e.g. `/etc/passwd`/`secure.json` into the downloads dir, then readable via `GET /api/files`. Gated on the `vid-dl` downloader being configured (may be off today, code live).
**Fix:** drop the `file:` branch, or restrict to paths already inside `dataDir`.

### C4. `secure.json` = a shared secret store any active user can read AND write
`server/routes/secure.js` has **no role check** — only the app-wide active-user gate. It holds the **shared TMDB Read Access Token** (+ SubDL/Wyzie keys). Confirmed: `src/App.jsx:313` fetches the raw token to the browser. Any approved user can `GET /api/secure/apikey` to exfiltrate it, or `PUT` garbage to break TMDB/subtitles for everyone. Header comment still says "Single-user."
**Fix:** admin-gate `PUT` (and ideally `GET`); finish moving client TMDB calls onto the server proxy (`routes/tmdb.js`) so the browser never needs the raw token.

### C5. `/vzy` proxy hands third-party JS first-party trust (session-riding)
`server/routes/vzy.js` serves Videasy's JS **same-origin** under `xtreamz.org`, **strips CSP/X-Frame/COOP/COEP** (`:100-103`) and **defeats Videasy's own anti-embed check** (`self!==top`→`(!1)`, `:64-68`). Any script videasy.to (or its ad/CDN chain — outside our control) ever serves runs as first-party code with the user's `sb_session` auto-attached to same-origin API calls → silent calls to `/api/admin/*` (if an admin is watching), `/api/secure/apikey`, `/api/proxy`, etc. Its own header says "SPIKE… NOT production-grade."
**Fix:** do not ship as-is publicly — either drop `/vzy` (Videasy is a nice-to-have; VidSrc Direct is the default), or re-add a strict CSP/`frame-ancestors`, stop stripping headers, and reconsider serving third-party JS same-origin at all.

### C6. Non-sandboxed embed iframe — clickjack/redirect for public viewers
`src/components/WebPlayer.jsx:46-57` has no `sandbox`; the documented mitigation is the LAN's AdGuard DNS, which **does not reach public internet viewers**. A malicious ad in any embed source can `top.location = phish` to hijack the tab for credential phishing.
**Fix:** add `sandbox` (test per-provider) or re-derive the risk for non-LAN clients.

### C7. `trustProxy: true` defeats login/register rate-limiting
`server/app.js:26`. Fastify walks the whole `X-Forwarded-For` and takes the leftmost (client-supplied) value as `req.ip`; nothing sanitizes it. Throttle keys use `req.ip` (`auth.js:15,45`), so an attacker rotates `X-Forwarded-For` per request → unlimited unthrottled password guessing against `admin` (8-char-min policy).
**Fix:** set `trustProxy` to the exact proxy hop/CIDR (Caddy/cloudflared), and confirm that layer overwrites inbound `X-Forwarded-For`. Re-verify after the tunnel topology is set (also affects the `secure` cookie decision).

### C8. Cookie-secret hardcoded fallback → forgeable admin session
`server/index.js:38`: `STREAMBERT_COOKIE_SECRET || "streambert-dev-secret-change-me"`. Compose enforces the var; the **raw `docker run` Vision deploy does not**. If ever unset, sessions are signed with a source-visible string (the repo is going public on GitHub) → forge `sb_session` for `id=1` (admin). Local `.env` has a real secret today; the code path is unguarded.
**Fix:** `index.js` must fail-fast if the secret is unset or the dev default; **verify the Vision `docker run` sets `STREAMBERT_COOKIE_SECRET`**.

---

## IMPORTANT — fix before or right at launch

- **I1. `/api/downloads` global, no per-user scoping/admin gate** (`server/routes/downloads.js`): any active user enumerates/deletes ALL users' downloads and spawns **unbounded** `vid-dl` processes (CPU/disk/bandwidth DoS). Contrast `state.js`, which scopes by `req.user.id` + a write-limiter. **Fix:** per-user scope + admin gate + concurrency cap.
- **I2. No security headers** (no CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, HSTS): the app can be framed anywhere (clickjacking on admin actions), no defense-in-depth, MIME-sniff exposure on the proxies. **Fix:** add via Caddy `header` block or a Fastify hook/helmet (CSP with `frame-ancestors 'none'`).
- **I3. Extractor has no per-user rate limit** (`server/routes/extract.js`): one active user can keep both extraction slots busy, starving everyone's playback. **Fix:** per-user cap.
- **I4. Login throttle is IP-scoped only** (`auth.js:15`): even with C7 fixed, a few IPs get a fresh budget each; add an IP-independent per-username cap (esp. for `admin`).

---

## MINOR — can follow shortly after launch

- Registration is an existence oracle (409 vs 200) for emails/phones (documented tradeoff; phones are privacy-sensitive).
- scrypt at the RFC interactive floor + 8-char-only password policy.
- 30-day sessions, no revocation list beyond DB status (mitigated by `httpOnly` + live DB lookup per request).
- `admin.js:19` `SELECT COUNT(*) FROM ${table}` unparameterized (only static literals today — refactor landmine).
- Confirm the **extractor sidecar port is unreachable from outside `streambert-net`** (Caddy/tunnel must never route to it) — deployment check, not code.

---

## Done well (preserve these)
- **SQL layer 100% parameterized** — zero SQL injection anywhere.
- **Registration/approval gate**: exact-path preHandler (no prefix bypass), single admin role hook over all `/api/admin/*`, `registerUser` hardcodes role/status (no mass-assignment), constant-time login (no user enumeration via timing), instant session revocation on delete/suspend (live DB lookup, not stateless JWT), SameSite=Lax + no CORS (sound CSRF posture), `httpOnly` cookie.
- **`child_process` is 100% argv-array** (`spawn`) — no command injection; puppeteer args are fixed.
- `isPathInside()` containment is correct in `files.js` and most of `downloads.js` — reuse it in `subtitles.js`.
- No hardcoded real secrets committed; `.gitignore` covers `.env`/`data/`/`*.db`.

---

## Recommended remediation order
1. **C7 + C8** (trustProxy + cookie secret) and the **deployment checks** (cookie-secret env set on Vision; extractor not routed publicly) — cheap, foundational.
2. **C1–C3** (SSRF + file read/write/delete) — one shared URL-guard helper + reuse `isPathInside`; the highest blast-radius bugs.
3. **C4** (admin-gate `/api/secure`).
4. **C5 + C6** (decide `/vzy`'s fate; sandbox the iframe) + **I2** (security headers) — these three are the "third-party content" cluster.
5. **I1, I3, I4** (downloads scoping, extractor + username throttle).
6. Minors as time allows.

None of this touches the registration/approval feature you just shipped — that part audited clean. The work is hardening the *pre-existing* LAN-era surface for public exposure.
