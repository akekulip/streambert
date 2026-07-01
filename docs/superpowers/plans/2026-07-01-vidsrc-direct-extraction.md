# VidSrc Direct Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "VidSrc Direct" source that plays movies/TV as a clean ad-free HLS stream extracted server-side by a headless-Chrome sidecar, played through the existing hls.js + `/api/proxy` path.

**Architecture:** A new internal `streambert-extractor` sidecar (Node + puppeteer-core + Chromium) sniffs the token'd VidSrc `.m3u8`. The `streambert` app calls it via a cached route (`/api/extract/vidsrc`) and plays the result via `WebMediaPlayer`, with a new m3u8-rewrite step in `/api/proxy` so hls.js re-proxies VidSrc's absolute-path variants from the server IP. App image stays browser-less.

**Tech Stack:** Node 20, Fastify (app), puppeteer-core + Chromium (extractor), hls.js (frontend, present), Docker raw `docker run` on `streambert-net`.

## Global Constraints

- The extractor container is internal only — on `streambert-net`, never port-published.
- The `streambert` app image stays browser-less (no Chromium/puppeteer in it).
- Cache TTL for an extracted stream is 3 hours (< the ~4h token `exp`).
- `/api/extract/vidsrc` is session-gated (automatic: `server/app.js` preHandler gates all non-OPEN `/api/*`).
- VidSrc's `rcpHost` rotates; read it dynamically from the embed, never hard-code.
- Deployment stays raw `docker run` on `streambert-net`; the Caddy container is untouched.
- Tests use `node:test` + `node:assert` (see `server/test/*.test.js`). Run server tests with `node --test server/test/`.

---

### Task 1: Extractor sidecar service

**Files:**
- Create: `extractor/package.json`
- Create: `extractor/extract.js`
- Create: `extractor/server.js`
- Create: `extractor/Dockerfile`
- Test: `extractor/test/extract.test.js`

**Interfaces:**
- Produces (`extract.js`): `buildEmbedUrl({tmdb,type,season,episode}) -> string`; `parseRcpUrl(embedHtml) -> string|null`; `extractStream({tmdb,type,season,episode}) -> Promise<{m3u8,referer}>` (throws `NoStreamError`/`TimeoutError`); error classes `NoStreamError`, `TimeoutError`.
- Produces (`server.js`): `handleExtract(body, {extractStream}) -> Promise<{status,json}>`; an HTTP server on `PORT` (default 8788) with `GET /health` and `POST /extract`.

- [ ] **Step 1: Create `extractor/package.json`**

```json
{
  "name": "streambert-extractor",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": { "start": "node server.js", "test": "node --test test/" },
  "dependencies": { "puppeteer-core": "^23.0.0" }
}
```

- [ ] **Step 2: Write the failing test `extractor/test/extract.test.js`**

```javascript
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { buildEmbedUrl, parseRcpUrl } = require("../extract");
const { handleExtract } = require("../server");

test("buildEmbedUrl builds movie and tv urls", () => {
  assert.equal(buildEmbedUrl({ tmdb: "550", type: "movie" }), "https://vidsrc.me/embed/movie/550");
  assert.equal(buildEmbedUrl({ tmdb: "1396", type: "tv", season: 1, episode: 1 }), "https://vidsrc.me/embed/tv/1396/1/1");
});

test("parseRcpUrl extracts the rcp iframe url", () => {
  const html = `<div><iframe id="player_iframe" src="//cloudx.example.com/rcp/ABC123=="></iframe></div>`;
  assert.equal(parseRcpUrl(html), "https://cloudx.example.com/rcp/ABC123==");
  assert.equal(parseRcpUrl("<div>no player here</div>"), null);
});

test("handleExtract validates input", async () => {
  const okStream = async () => ({ m3u8: "https://cdn/master.m3u8?token=x", referer: "https://cdn/" });
  assert.equal((await handleExtract({}, { extractStream: okStream })).status, 400);
  assert.equal((await handleExtract({ tmdb: "1", type: "bad" }, { extractStream: okStream })).status, 400);
  assert.equal((await handleExtract({ tmdb: "1", type: "tv" }, { extractStream: okStream })).status, 400);
  const ok = await handleExtract({ tmdb: "550", type: "movie" }, { extractStream: okStream });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.m3u8, "https://cdn/master.m3u8?token=x");
});

test("handleExtract maps extractor errors to status codes", async () => {
  const { NoStreamError, TimeoutError } = require("../extract");
  const noStream = async () => { throw new NoStreamError("no m3u8"); };
  const timeout = async () => { throw new TimeoutError("slow"); };
  assert.equal((await handleExtract({ tmdb: "1", type: "movie" }, { extractStream: noStream })).status, 404);
  assert.equal((await handleExtract({ tmdb: "1", type: "movie" }, { extractStream: timeout })).status, 504);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd extractor && node --test test/`
Expected: FAIL — `Cannot find module '../extract'`.

- [ ] **Step 4: Write `extractor/extract.js`**

```javascript
"use strict";
// VidSrc stream extraction: embed -> rcp player -> sniff the token'd .m3u8.
// All VidSrc-specific / puppeteer code lives here (never in the app image).
const https = require("https");
const puppeteer = require("puppeteer-core");

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const VIDSRC = "https://vidsrc.me";
const MAX_CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 20000;

class NoStreamError extends Error { constructor(m) { super(m); this.name = "NoStreamError"; } }
class TimeoutError extends Error { constructor(m) { super(m); this.name = "TimeoutError"; } }

function buildEmbedUrl({ tmdb, type, season, episode }) {
  return type === "tv"
    ? `${VIDSRC}/embed/tv/${tmdb}/${season}/${episode}`
    : `${VIDSRC}/embed/movie/${tmdb}`;
}

function parseRcpUrl(embedHtml) {
  const m = embedHtml.match(/src="(\/\/[^"]*\/rcp\/[^"]+)"/);
  return m ? "https:" + m[1] : null;
}

function httpGet(url, referer) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": UA, Referer: referer || `https://${u.hostname}/` } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpGet(res.headers.location.startsWith("http") ? res.headers.location : `https://${u.hostname}${res.headers.location}`, referer).then(resolve, reject);
        }
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("embed timeout")));
    req.end();
  });
}

let browserP = null;
async function getBrowser() {
  if (browserP) { try { const b = await browserP; if (b.connected) return b; } catch { /* relaunch */ } }
  browserP = puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  return browserP;
}

let active = 0;
const queue = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENCY) await new Promise((r) => queue.push(r));
  active++;
  try { return await fn(); }
  finally { active--; const next = queue.shift(); if (next) next(); }
}

function withTimeout(ms, promise) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new TimeoutError("extract timeout")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function sniff(rcpUrl) {
  const browser = await getBrowser();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ Referer: `${VIDSRC}/` });
    const hits = [];
    page.on("request", (r) => { const u = r.url(); if (/\.m3u8/i.test(u) && !/__TOKEN__/.test(u)) hits.push(u); });
    await page.goto(rcpUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 4 && hits.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try { await page.mouse.click(640, 360); } catch { /* ignore */ }
      for (const f of page.frames()) { try { await f.click("body"); } catch { /* ignore */ } }
    }
    if (hits.length === 0) throw new NoStreamError("no m3u8 intercepted");
    return { m3u8: hits[0], referer: `https://${new URL(hits[0]).hostname}/` };
  } finally { await ctx.close().catch(() => {}); }
}

async function extractStream({ tmdb, type, season, episode }) {
  const embedHtml = await httpGet(buildEmbedUrl({ tmdb, type, season, episode }), `${VIDSRC}/`);
  const rcpUrl = parseRcpUrl(embedHtml);
  if (!rcpUrl) throw new NoStreamError("no rcp iframe in embed");
  return withSlot(() => withTimeout(REQUEST_TIMEOUT_MS, sniff(rcpUrl)));
}

module.exports = { buildEmbedUrl, parseRcpUrl, extractStream, NoStreamError, TimeoutError };
```

- [ ] **Step 5: Write `extractor/server.js`**

```javascript
"use strict";
const http = require("http");
const { extractStream, NoStreamError, TimeoutError } = require("./extract");

async function handleExtract(body, deps) {
  const run = (deps && deps.extractStream) || extractStream;
  const { tmdb, type, season, episode } = body || {};
  if (!tmdb || (type !== "movie" && type !== "tv")) return { status: 400, json: { error: "tmdb and type(movie|tv) required" } };
  if (type === "tv" && (season == null || episode == null)) return { status: 400, json: { error: "season and episode required for tv" } };
  try {
    const { m3u8, referer } = await run({ tmdb: String(tmdb), type, season, episode });
    return { status: 200, json: { m3u8, referer } };
  } catch (e) {
    if (e instanceof TimeoutError || e.name === "TimeoutError") return { status: 504, json: { error: "extract timeout" } };
    if (e instanceof NoStreamError || e.name === "NoStreamError") return { status: 404, json: { error: "no stream" } };
    return { status: 500, json: { error: "extract failed" } };
  }
}

function start(port = Number(process.env.PORT) || 8788) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true })); }
    if (req.method === "POST" && req.url === "/extract") {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", async () => {
        let body; try { body = JSON.parse(b || "{}"); } catch { body = {}; }
        const { status, json } = await handleExtract(body);
        res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(json));
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  server.listen(port, () => console.log(`extractor listening on ${port}`));
  return server;
}

if (require.main === module) start();
module.exports = { handleExtract, start };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd extractor && npm install && node --test test/`
Expected: PASS — 4 tests. (No Chromium needed; `extractStream` is mocked.)

- [ ] **Step 7: Write `extractor/Dockerfile`**

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PORT=8788
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY extract.js server.js ./
COPY test ./test
EXPOSE 8788
CMD ["node", "server.js"]
```

- [ ] **Step 8: Commit**

```bash
git add extractor/
git commit -m "feat(extractor): VidSrc headless stream-extraction sidecar service"
```

---

### Task 2: Proxy m3u8 rewrite

**Files:**
- Create: `server/lib/m3u8.js`
- Modify: `server/routes/proxy.js`
- Test: `server/test/m3u8.test.js`

**Interfaces:**
- Produces: `rewriteM3u8(body: string, baseUrl: string) -> string` — rewrites every playlist URI (line URIs + `URI="…"` attrs) to an absolute URL resolved against `baseUrl`; leaves comments/tags otherwise unchanged.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test `server/test/m3u8.test.js`**

```javascript
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { rewriteM3u8 } = require("../lib/m3u8");

test("rewriteM3u8 makes nested URIs absolute against the master URL", () => {
  const base = "https://cdn.example.com/pl/GZIP/master.m3u8?token=T";
  const body = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1",
    "/pl/GZIP/HASH/index.m3u8?token=T2",
    "#EXT-X-STREAM-INF:BANDWIDTH=2",
    "sub/index.m3u8",
  ].join("\n");
  const out = rewriteM3u8(body, base).split("\n");
  assert.equal(out[2], "https://cdn.example.com/pl/GZIP/HASH/index.m3u8?token=T2");
  assert.equal(out[4], "https://cdn.example.com/pl/GZIP/sub/index.m3u8");
  assert.equal(out[0], "#EXTM3U");
});

test("rewriteM3u8 rewrites URI= attributes and leaves other tags", () => {
  const base = "https://cdn.example.com/v/index.m3u8";
  const body = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nseg0.ts';
  const out = rewriteM3u8(body, base);
  assert.match(out, /URI="https:\/\/cdn\.example\.com\/v\/key\.bin"/);
  assert.match(out, /https:\/\/cdn\.example\.com\/v\/seg0\.ts/);
  assert.match(out, /#EXTINF:6,/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/test/m3u8.test.js`
Expected: FAIL — `Cannot find module '../lib/m3u8'`.

- [ ] **Step 3: Write `server/lib/m3u8.js`**

```javascript
"use strict";
// Rewrite an HLS playlist so every nested URI is an absolute URL. hls.js
// resolves relative/rooted URIs against the page origin, not the CDN, so
// without this the browser can't re-proxy VidSrc's absolute-path variants.
function rewriteM3u8(body, baseUrl) {
  return body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t === "") return line;
      if (t.startsWith("#")) {
        // Rewrite any URI="..." attribute (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP).
        return line.replace(/URI="([^"]+)"/g, (_m, u) => {
          try { return `URI="${new URL(u, baseUrl).href}"`; } catch { return _m; }
        });
      }
      try { return new URL(t, baseUrl).href; } catch { return line; }
    })
    .join("\n");
}
module.exports = { rewriteM3u8 };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test server/test/m3u8.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Wire the rewrite into `server/routes/proxy.js`**

At the top, after the existing `const http = require("http");` line, add:

```javascript
const { rewriteM3u8 } = require("../lib/m3u8");
```

In the `fastify.get("/", ...)` handler, replace the final block that begins `// Pass through the upstream status` and ends with `return reply.send(upstream);` with:

```javascript
    // HLS playlists: buffer + rewrite nested URIs to absolute CDN URLs so the
    // hls.js ProxyLoader re-proxies each variant/segment (with referer) from
    // this server's IP. Everything else streams through unchanged.
    const ctype = (upstream.headers["content-type"] || "").toLowerCase();
    const isPlaylist = ctype.includes("mpegurl") || parsed.pathname.toLowerCase().endsWith(".m3u8");
    if (isPlaylist) {
      const chunks = [];
      for await (const c of upstream) chunks.push(c);
      const rewritten = rewriteM3u8(Buffer.concat(chunks).toString("utf8"), url);
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .code(upstream.statusCode || 200)
        .send(rewritten);
    }

    // Pass through the upstream status (200 / 206 partial) + selected headers.
    for (const h of PASS_HEADERS) {
      if (upstream.headers[h]) reply.header(h, upstream.headers[h]);
    }
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", "Range")
      .header(
        "Access-Control-Expose-Headers",
        "Content-Range, Accept-Ranges, Content-Length, Content-Type",
      )
      .header("Cache-Control", "no-store")
      .code(upstream.statusCode || 502);

    reply.raw.on("close", () => {
      try { upstream.destroy(); } catch { /* ignore */ }
    });

    return reply.send(upstream);
```

- [ ] **Step 6: Run the full server suite to confirm no regressions**

Run: `node --test server/test/`
Expected: PASS — all existing tests + the 2 new m3u8 tests.

- [ ] **Step 7: Commit**

```bash
git add server/lib/m3u8.js server/test/m3u8.test.js server/routes/proxy.js
git commit -m "feat(proxy): rewrite HLS playlists to absolute URLs for re-proxying"
```

---

### Task 3: App extract route + cache

**Files:**
- Create: `server/lib/streamCache.js`
- Create: `server/routes/extract.js`
- Modify: `server/app.js:64` (register the route)
- Test: `server/test/streamCache.test.js`, `server/test/extract.test.js`

**Interfaces:**
- Produces (`streamCache.js`): `createCache({ttlMs,max}) -> { get(key)->val|null, set(key,val), _size()->number }`.
- Produces (route): `POST /api/extract/vidsrc` body `{tmdb,type,season?,episode?}` → `200 {url,referer[,cached]}` | `400/404/502/503 {error}`. Reads `process.env.STREAMBERT_EXTRACTOR_URL` (default `http://streambert-extractor:8788`) inside the handler.
- Consumes: the extractor's `POST /extract` from Task 1 (contract `{m3u8,referer}`).

- [ ] **Step 1: Write the failing test `server/test/streamCache.test.js`**

```javascript
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createCache } = require("../lib/streamCache");

test("cache stores and returns values", () => {
  const c = createCache({ ttlMs: 1000, max: 10 });
  c.set("k", { url: "u" });
  assert.deepEqual(c.get("k"), { url: "u" });
  assert.equal(c.get("missing"), null);
});

test("cache expires entries past ttl", async () => {
  const c = createCache({ ttlMs: 10, max: 10 });
  c.set("k", 1);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.get("k"), null);
});

test("cache evicts oldest past max", () => {
  const c = createCache({ ttlMs: 10000, max: 2 });
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  assert.equal(c.get("a"), null);
  assert.equal(c.get("c"), 3);
  assert.equal(c._size(), 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/test/streamCache.test.js`
Expected: FAIL — `Cannot find module '../lib/streamCache'`.

- [ ] **Step 3: Write `server/lib/streamCache.js`**

```javascript
"use strict";
// Tiny TTL + max-size cache. Insertion order = eviction order (Map).
function createCache({ ttlMs, max }) {
  const m = new Map();
  return {
    get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (Date.now() - e.ts > ttlMs) { m.delete(key); return null; }
      return e.val;
    },
    set(key, val) {
      if (!m.has(key) && m.size >= max) m.delete(m.keys().next().value);
      m.set(key, { val, ts: Date.now() });
    },
    _size: () => m.size,
  };
}
module.exports = { createCache };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test server/test/streamCache.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write `server/routes/extract.js`**

```javascript
"use strict";
// Stream-extraction routes. Calls the internal streambert-extractor sidecar
// and caches its result (tokens are IP+time-bound; TTL < token exp ~4h).
const { createCache } = require("../lib/streamCache");

const cache = createCache({ ttlMs: 3 * 60 * 60 * 1000, max: 500 });

module.exports = async function (fastify) {
  // POST /api/extract/vidsrc  { tmdb, type:"movie"|"tv", season?, episode? }
  //   -> 200 { url, referer } | 400/404/502/503 { error }
  fastify.post("/vidsrc", async (req, reply) => {
    const { tmdb, type, season, episode } = req.body || {};
    if (!tmdb || (type !== "movie" && type !== "tv"))
      return reply.code(400).send({ error: "tmdb and type(movie|tv) required" });

    const key = `${type}:${tmdb}:${season ?? 0}:${episode ?? 0}`;
    const hit = cache.get(key);
    if (hit) return { url: hit.url, referer: hit.referer, cached: true };

    const base = process.env.STREAMBERT_EXTRACTOR_URL || "http://streambert-extractor:8788";
    let res;
    try {
      res = await fetch(`${base}/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tmdb, type, season, episode }),
      });
    } catch {
      return reply.code(503).send({ error: "extractor unavailable" });
    }
    if (res.status === 404) return reply.code(404).send({ error: "no stream" });
    if (!res.ok) return reply.code(502).send({ error: "extract failed" });

    const data = await res.json();
    if (!data.m3u8) return reply.code(502).send({ error: "extract failed" });
    cache.set(key, { url: data.m3u8, referer: data.referer });
    return { url: data.m3u8, referer: data.referer };
  });
};
```

- [ ] **Step 6: Register the route in `server/app.js`**

After the line `await tryRegister("./routes/proxy", { prefix: "/api/proxy" });` (line 64), add:

```javascript
  await tryRegister("./routes/extract", { prefix: "/api/extract" });
```

- [ ] **Step 7: Write the failing route test `server/test/extract.test.js`**

```javascript
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function makeApp() {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const app = await buildApp({ db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(), dataDir: os.tmpdir(), distDir: "/nonexistent" });
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  const cookie = r.cookies.find((c) => c.name === "sb_session").value;
  return { app, cookie };
}

test("extract requires auth", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "POST", url: "/api/extract/vidsrc", payload: { tmdb: "550", type: "movie" } });
  assert.equal(r.statusCode, 401);
});

test("extract calls the sidecar once, then serves from cache", async () => {
  let calls = 0;
  const mock = http.createServer((req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ m3u8: "https://cdn/master.m3u8?token=x", referer: "https://cdn/" }));
  });
  await new Promise((r) => mock.listen(0, r));
  process.env.STREAMBERT_EXTRACTOR_URL = `http://127.0.0.1:${mock.address().port}`;

  const { app, cookie } = await makeApp();
  const body = { tmdb: "777001", type: "movie" }; // unique tmdb -> no cross-test cache hit
  const first = await app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: body });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().url, "https://cdn/master.m3u8?token=x");
  assert.equal(first.json().referer, "https://cdn/");

  const second = await app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: body });
  assert.equal(second.json().cached, true);
  assert.equal(calls, 1, "sidecar called once; second served from cache");

  const bad = await app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: { type: "movie" } });
  assert.equal(bad.statusCode, 400);
  mock.close();
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test server/test/extract.test.js`
Expected: PASS — 2 tests (auth 401; call-once-then-cache + 400 validation).

- [ ] **Step 9: Commit**

```bash
git add server/lib/streamCache.js server/routes/extract.js server/app.js server/test/streamCache.test.js server/test/extract.test.js
git commit -m "feat(server): /api/extract/vidsrc route with 3h stream cache"
```

---

### Task 4: Frontend "VidSrc Direct" source + wiring

**Files:**
- Modify: `src/utils/api.js` (add source, `resolver` fields, `getSourceResolver`)
- Modify: `src/web/electron-shim.js` (add `extractVidsrc`)
- Modify: `src/pages/MoviePage.jsx` (branch the async resolve)
- Modify: `src/pages/TVPage.jsx` (branch the async resolve)

**Interfaces:**
- Consumes: `POST /api/extract/vidsrc` → `{url,referer}` (Task 3), via the shim.
- Produces (`api.js`): `getSourceResolver(sourceId) -> "vidsrc"|"allmanga"|null`; new source id `"vidsrc-direct"` (`async:true`, `resolver:"vidsrc"`).
- Produces (`electron-shim.js`): `window.electron.extractVidsrc({tmdb,type,season,episode}) -> Promise<{url,referer}|{error}>`.

- [ ] **Step 1: Add the source + resolver helper in `src/utils/api.js`**

In `PLAYER_SOURCES`, add `resolver: "allmanga",` to the `allmanga` entry (just after its `async: true,` line), and append a new entry after `allmanga`:

```javascript
  {
    id: "vidsrc-direct",
    label: "VidSrc Direct",
    tag: null,
    note: "Server-extracted, ad-free",
    supportsProgress: false,
    async: true,
    resolver: "vidsrc",
    params: {},
    movieUrl: (id) => `https://vidsrc.me/embed/movie/${id}`,
    tvUrl: (id, season, ep) => `https://vidsrc.me/embed/tv/${id}/${season}/${ep}`,
  },
```

After the `getNextNonAsyncSource` export, add:

```javascript
// Which async resolver a source uses: "vidsrc" (server extraction) | "allmanga".
export const getSourceResolver = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.resolver ?? null;
```

- [ ] **Step 2: Add `extractVidsrc` to `src/web/electron-shim.js`**

After the `resolveAllManga: (args) => post("/allmanga/resolve", args),` line, add:

```javascript
    extractVidsrc: (args) => post("/extract/vidsrc", args),
```

- [ ] **Step 3: Branch the async resolve in `src/pages/MoviePage.jsx`**

Add `getSourceResolver,` to the import from `../utils/api` (next to `getNextNonAsyncSource,`).

In the AllManga resolve effect, wrap the existing resolve call in a resolver ternary. **Keep the existing `resolveAllManga({...})` arguments exactly as they are** — move that whole call, unchanged, into the `else` branch; do not rewrite its argument object. Find:

```javascript
    window.electron
      .resolveAllManga({
```

Replace from `window.electron.resolveAllManga({` (the start of that call) up to and including the `.then((res) => {` that follows the call's closing `})` with the structure below, pasting the **original** `resolveAllManga({...})` argument object verbatim where marked:

```javascript
    const resolver = getSourceResolver(playerSource);
    const resolvePromise =
      resolver === "vidsrc"
        ? window.electron
            .extractVidsrc({ tmdb: String(item.id), type: "movie" })
            .then((r) => (r?.url ? { ok: true, url: r.url, referer: r.referer } : { ok: false, error: r?.error }))
        : window.electron.resolveAllManga(/* PASTE THE ORIGINAL ARGUMENT OBJECT HERE, UNCHANGED */);
    resolvePromise
      .then((res) => {
```

(The existing `.then` body already handles `{ ok, url, referer }` → `setWebMedia`; the `.catch`/`.finally` and `doFailover` are unchanged. The `vidsrc` branch normalizes the `{url,referer}` route response into the same `{ok,url,referer}` shape that body expects.)

- [ ] **Step 4: Branch the async resolve in `src/pages/TVPage.jsx`**

Add `getSourceResolver,` to the import from `../utils/api`. Apply the same transform as MoviePage, passing TV params to `extractVidsrc` and **keeping the existing `resolveAllManga({...})` arguments verbatim** in the `else` branch. Find `window.electron` `.resolveAllManga({` in TVPage and replace from that call up to and including the `.then((res) => {` after its closing `})` with:

```javascript
    const resolver = getSourceResolver(playerSource);
    const resolvePromise =
      resolver === "vidsrc"
        ? window.electron
            .extractVidsrc({ tmdb: String(item.id), type: "tv", season: selectedSeason, episode: epNum })
            .then((r) => (r?.url ? { ok: true, url: r.url, referer: r.referer } : { ok: false, error: r?.error }))
        : window.electron.resolveAllManga(/* PASTE THE ORIGINAL ARGUMENT OBJECT HERE, UNCHANGED */);
    resolvePromise
      .then((res) => {
```

(`epNum` and `selectedSeason` are already defined above this point in the effect. If the original call used a differently named episode variable, keep it — only the `vidsrc` branch is new.)

- [ ] **Step 5: Build to verify the frontend compiles**

Run: `npm run build`
Expected: `✓ built in …s`, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/api.js src/web/electron-shim.js src/pages/MoviePage.jsx src/pages/TVPage.jsx
git commit -m "feat(web): VidSrc Direct source wired to server extraction"
```

---

### Task 5: Deployment + docs

**Files:**
- Modify: `docs/DEPLOY.md` (document the extractor container)
- Modify: `docs/superpowers/specs/2026-07-01-vidsrc-direct-extraction-design.md` is the reference (no change)

**Interfaces:**
- Consumes: `extractor/` image (Task 1), the app's `STREAMBERT_EXTRACTOR_URL` env (Task 3).

> Deployment runs against Vision (`decps@10.10.54.19`) — the only host with Docker. The controller (not a code subagent) executes this task.

- [ ] **Step 1: Sync + build the extractor image on Vision**

```bash
rsync -az --exclude node_modules extractor/ decps@10.10.54.19:/home/decps/streambert/extractor/
ssh decps@10.10.54.19 'cd /home/decps/streambert/extractor && docker build -t streambert-extractor:latest .'
```
Expected: image builds; `docker images | grep streambert-extractor` shows it.

- [ ] **Step 2: Run the extractor container on `streambert-net`**

```bash
ssh decps@10.10.54.19 'docker rm -f streambert-extractor 2>/dev/null; \
  docker run -d --name streambert-extractor --restart unless-stopped \
    --network streambert-net --memory=1500m \
    --log-opt max-size=10m --log-opt max-file=3 \
    streambert-extractor:latest'
ssh decps@10.10.54.19 'docker exec streambert-extractor wget -qO- http://localhost:8788/health'
```
Expected: `{"ok":true}`.

- [ ] **Step 3: Recreate the app container with the extractor env**

Follow the standard app recreate (see project memory), adding `-e STREAMBERT_EXTRACTOR_URL=http://streambert-extractor:8788` to the `docker run` for `streambert`. Verify `https://10.10.54.19/` → 200 and the app can reach the sidecar:

```bash
ssh decps@10.10.54.19 'docker exec streambert wget -qO- http://streambert-extractor:8788/health'
```
Expected: `{"ok":true}`.

- [ ] **Step 4: Live end-to-end check**

Log into the app, open a movie, pick "VidSrc Direct", confirm it plays in the native player (not an iframe). As a scripted check, extract via the API (with an auth cookie) and confirm a proxied manifest:

```bash
# (on Vision, authenticated) expect JSON { url, referer }
curl -sk -b /tmp/c https://10.10.54.19/api/extract/vidsrc -H 'content-type: application/json' -d '{"tmdb":"550","type":"movie"}'
```
Expected: `{"url":"https://…/master.m3u8?token=…","referer":"https://…/"}`.

- [ ] **Step 5: Document the three-container topology in `docs/DEPLOY.md`**

Add a short "Extractor sidecar" subsection: the `streambert-extractor` container (internal-only, `streambert-net`, `--memory=1500m`, log-rotation), how to build/run it, and the app's `STREAMBERT_EXTRACTOR_URL` env. Note the upkeep caveat (VidSrc rotates hosts/obfuscation; rebuild the extractor image when it breaks).

- [ ] **Step 6: Commit**

```bash
git add docs/DEPLOY.md
git commit -m "docs: document the streambert-extractor sidecar deployment"
```

---

## Notes for the executor

- After Task 3, update the project memory deploy note to mention the extractor container + `STREAMBERT_EXTRACTOR_URL` (the controller handles memory).
- The extractor's live extraction is network-dependent and not covered by CI; Task 5 Step 4 is the real end-to-end gate.
- If VidSrc later blocks headless Chrome, the fix is contained to `extractor/` (headful/xvfb or stealth) — no app changes.
