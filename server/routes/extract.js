"use strict";
// Stream-extraction routes. The shared extract client (fastify.extractClient,
// see lib/extract.js) talks to the streambert-extractor sidecar and owns the
// result cache — shared with the pre-warmer so warmed streams serve plays.

module.exports = async function (fastify) {
  // POST /api/extract/vidsrc  { tmdb, type:"movie"|"tv", season?, episode? }
  //   -> 200 { url, referer } | 400/404/502/503 { error }
  fastify.post("/vidsrc", async (req, reply) => {
    const { tmdb, type, season, episode } = req.body || {};
    if (!tmdb || (type !== "movie" && type !== "tv"))
      return reply.code(400).send({ error: "tmdb and type(movie|tv) required" });

    const r = await fastify.extractClient.extract({ tmdb, type, season, episode });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    if (r.cached) return { url: r.url, referer: r.referer, cached: true };
    return { url: r.url, referer: r.referer };
  });
};
