"use strict";
// Stream-extraction client — calls the streambert-extractor sidecar and
// caches results (tokens are IP+time-bound; TTL < token exp ~4h). Shared by
// the /api/extract route and the pre-warmer so both serve one cache.

const { createCache } = require("./streamCache");

const jobKey = ({ type, tmdb, season, episode }) =>
  `${type}:${tmdb}:${season ?? 0}:${episode ?? 0}`;

function createExtractClient() {
  const cache = createCache({ ttlMs: 3 * 60 * 60 * 1000, max: 500 });
  let hits = 0;
  let misses = 0;

  async function extract(job) {
    const key = jobKey(job);
    const hit = cache.get(key);
    if (hit) {
      hits++;
      return { ok: true, cached: true, url: hit.url, referer: hit.referer };
    }
    misses++;
    const base =
      process.env.STREAMBERT_EXTRACTOR_URL || "http://streambert-extractor:8788";
    let res;
    try {
      res = await fetch(`${base}/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tmdb: job.tmdb,
          type: job.type,
          season: job.season,
          episode: job.episode,
        }),
      });
    } catch {
      return { ok: false, status: 503, error: "extractor unavailable" };
    }
    if (res.status === 404) return { ok: false, status: 404, error: "no stream" };
    if (!res.ok) return { ok: false, status: 502, error: "extract failed" };
    const data = await res.json();
    if (!data.m3u8) return { ok: false, status: 502, error: "extract failed" };
    cache.set(key, { url: data.m3u8, referer: data.referer });
    return { ok: true, cached: false, url: data.m3u8, referer: data.referer };
  }

  return {
    extract,
    isCached: (job) => !!cache.get(jobKey(job)),
    stats: () => ({ entries: cache._size(), hits, misses }),
  };
}

module.exports = { createExtractClient, jobKey };
