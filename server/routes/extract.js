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
