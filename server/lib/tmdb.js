"use strict";
// Server-side TMDB fetcher for the recommendations engine. Token resolution
// mirrors routes/secure.js (a UI-saved key in secure.json wins over the env
// default), with a small TTL cache + in-flight dedupe so a burst of
// recommend() calls doesn't hammer TMDB. The fuller shared TMDB cache is
// roadmap item ① — this stays lean on purpose.

const fs = require("fs");
const path = require("path");

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;
const TOKEN_TTL_MS = 60 * 1000;

function createTmdb({ dataDir, fetchImpl = fetch } = {}) {
  const cache = new Map(); // path -> { at, promise }
  let token = null;
  let tokenAt = 0;

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
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
    const t = getToken();
    if (!t) return Promise.reject(new Error("no TMDB token"));
    const promise = fetchImpl(`https://api.themoviedb.org/3${p}`, {
      headers: { Authorization: `Bearer ${t}`, accept: "application/json" },
    }).then((res) => {
      if (!res.ok) throw new Error(`TMDB ${res.status} for ${p}`);
      return res.json();
    });
    cache.set(p, { at: Date.now(), promise });
    promise.catch(() => cache.delete(p)); // never cache failures
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return promise;
  };

  fetchTmdb.hasToken = () => !!getToken();
  fetchTmdb.stats = () => ({ entries: cache.size });
  fetchTmdb.clear = () => cache.clear();
  return fetchTmdb;
}

module.exports = { createTmdb };
