"use strict";
// Server-side TMDB fetcher — the shared cache behind /api/tmdb (roadmap ①),
// the recommendations engine, and the pre-warmer. Token resolution mirrors
// routes/secure.js (a UI-saved key in secure.json wins over the env default).
// TTL by endpoint class: volatile lists (trending/search/discover…) expire in
// 30 minutes, stable metadata (details/seasons/credits) lives 6 hours.
// In-flight promises are cached, so concurrent identical requests dedupe.

const fs = require("fs");
const path = require("path");

const LIST_TTL_MS = 30 * 60 * 1000;
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000;
const LIST_RE =
  /(trending|popular|top_rated|now_playing|upcoming|airing_today|on_the_air|discover|search)/;
const MAX_ENTRIES = 2000;
const TOKEN_TTL_MS = 60 * 1000;

function createTmdb({ dataDir, fetchImpl = fetch } = {}) {
  const cache = new Map(); // path -> { at, ttl, promise }
  let token = null;
  let tokenAt = 0;
  let hits = 0;
  let misses = 0;

  const getToken = () => {
    if (Date.now() - tokenAt < TOKEN_TTL_MS) return token;
    tokenAt = Date.now();
    let saved = null;
    try {
      saved = JSON.parse(
        fs.readFileSync(path.join(dataDir, "secure.json"), "utf8"),
      ).apikey;
    } catch {
      /* no secure.json — env fallback below */
    }
    token = saved || process.env.STREAMBERT_TMDB_TOKEN || process.env.TMDB_TOKEN || null;
    return token;
  };

  const fetchTmdb = (p) => {
    const hit = cache.get(p);
    if (hit && Date.now() - hit.at < hit.ttl) {
      hits++;
      return hit.promise;
    }
    misses++;
    const t = getToken();
    if (!t) return Promise.reject(new Error("no TMDB token"));
    const promise = fetchImpl(`https://api.themoviedb.org/3${p}`, {
      headers: { Authorization: `Bearer ${t}`, accept: "application/json" },
    }).then((res) => {
      if (!res.ok) throw new Error(`TMDB ${res.status} for ${p}`);
      return res.json();
    });
    const ttl = LIST_RE.test(p) ? LIST_TTL_MS : DETAIL_TTL_MS;
    cache.set(p, { at: Date.now(), ttl, promise });
    promise.catch(() => cache.delete(p)); // never cache failures
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return promise;
  };

  fetchTmdb.hasToken = () => !!getToken();
  fetchTmdb.stats = () => ({ entries: cache.size, hits, misses });
  fetchTmdb.clear = () => cache.clear();
  return fetchTmdb;
}

module.exports = { createTmdb };
