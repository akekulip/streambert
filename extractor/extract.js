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
const MAX_REDIRECTS = 5;

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

function httpGet(url, referer, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": UA, Referer: referer || `https://${u.hostname}/` } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectCount >= MAX_REDIRECTS) return reject(new Error("too many redirects"));
          return httpGet(res.headers.location.startsWith("http") ? res.headers.location : `https://${u.hostname}${res.headers.location}`, referer, redirectCount + 1).then(resolve, reject);
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

function withTimeout(ms, promise, onTimeout) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => {
      if (onTimeout) { try { onTimeout(); } catch { /* ignore cleanup errors */ } }
      rej(new TimeoutError("extract timeout"));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function sniff(rcpUrl, handle) {
  const browser = await getBrowser();
  const ctx = await browser.createBrowserContext();
  if (handle) handle.ctx = ctx;
  const page = await ctx.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ Referer: `${VIDSRC}/` });
    const hits = [];
    page.on("request", (r) => { const u = r.url(); if (/\.m3u8/i.test(u) && !/__TOKEN__/.test(u)) hits.push(u); });
    await page.goto(rcpUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 3 && hits.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try { await page.mouse.click(640, 360); } catch { /* ignore */ }
      for (const f of page.frames()) { try { await f.click("body"); } catch { /* ignore */ } }
    }
    if (hits.length === 0) throw new NoStreamError("no m3u8 intercepted");
    return { m3u8: hits[0], referer: `https://${new URL(hits[0]).hostname}/` };
  } finally { await ctx.close().catch(() => {}); }
}

// The 20s deadline covers the whole request: queue wait (withSlot) + embed
// fetch + rcp parse + sniff. withTimeout wraps withSlot (not the reverse) so
// a timed-out request keeps holding its concurrency slot until the real work
// actually tears down (withSlot's `finally` only runs when its inner fn
// settles) — on timeout we also proactively close the browser context so
// Chromium teardown isn't left to sniff's own (now shorter) internal budget.
async function extractStream({ tmdb, type, season, episode }) {
  const handle = { ctx: null };
  return withTimeout(
    REQUEST_TIMEOUT_MS,
    withSlot(async () => {
      const embedHtml = await httpGet(buildEmbedUrl({ tmdb, type, season, episode }), `${VIDSRC}/`);
      const rcpUrl = parseRcpUrl(embedHtml);
      if (!rcpUrl) throw new NoStreamError("no rcp iframe in embed");
      return sniff(rcpUrl, handle);
    }),
    () => { if (handle.ctx) handle.ctx.close().catch(() => {}); },
  );
}

module.exports = { buildEmbedUrl, parseRcpUrl, extractStream, withTimeout, NoStreamError, TimeoutError };
