"use strict";
// Server-cached TMDB proxy (roadmap item ①). Session-gated GETs only; the
// shared fetcher in lib/tmdb.js supplies per-class TTL caching, so all users
// share one cache at LAN latency. Web clients prefer this over direct
// api.themoviedb.org calls (src/utils/api.js falls back when absent).

const ALLOWED = new Set([
  "movie", "tv", "search", "trending", "genre", "discover",
  "person", "collection", "find", "configuration",
]);

module.exports = async function (fastify) {
  fastify.get("/*", async (req, reply) => {
    const tmdb = fastify.tmdbFetch;
    if (!tmdb || (tmdb.hasToken && !tmdb.hasToken())) {
      return reply.code(503).send({ error: "tmdb token not configured" });
    }
    const sub = req.params["*"] || "";
    if (!ALLOWED.has(sub.split("/")[0])) {
      return reply.code(404).send({ error: "not proxied" });
    }
    const qs = req.raw.url.split("?")[1];
    try {
      return await tmdb(`/${sub}${qs ? `?${qs}` : ""}`);
    } catch {
      return reply.code(502).send({ error: "tmdb fetch failed" });
    }
  });
};
