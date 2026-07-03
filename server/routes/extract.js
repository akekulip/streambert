"use strict";
// Stream-extraction routes. The shared extract client (fastify.extractClient,
// see lib/extract.js) talks to the streambert-extractor sidecar and owns the
// result cache — shared with the pre-warmer so warmed streams serve plays.

// Per-user in-flight cap: the extractor sidecar has only a couple of
// concurrent slots, so one account firing overlapping extract requests could
// monopolize all of them and starve every other user. Track in-flight
// extractions per req.user.id in a module-level Map and reject once a user is
// already at the cap; the count is always released in a `finally` so it can
// never leak on error/timeout.
const MAX_INFLIGHT_PER_USER = 1;
const inflight = new Map(); // userId -> count of in-flight extractions

function tryAcquire(userId) {
  const n = inflight.get(userId) || 0;
  if (n >= MAX_INFLIGHT_PER_USER) return false;
  inflight.set(userId, n + 1);
  return true;
}

function release(userId) {
  const n = inflight.get(userId) || 0;
  if (n <= 1) inflight.delete(userId);
  else inflight.set(userId, n - 1);
}

module.exports = async function (fastify) {
  // POST /api/extract/vidsrc  { tmdb, type:"movie"|"tv", season?, episode? }
  //   -> 200 { url, referer } | 400/404/429/502/503 { error }
  fastify.post("/vidsrc", async (req, reply) => {
    const { tmdb, type, season, episode } = req.body || {};
    if (!tmdb || (type !== "movie" && type !== "tv"))
      return reply.code(400).send({ error: "tmdb and type(movie|tv) required" });

    if (!tryAcquire(req.user.id)) {
      return reply.code(429).send({ error: "extraction already in progress" });
    }
    try {
      const r = await fastify.extractClient.extract({ tmdb, type, season, episode });
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      if (r.cached) return { url: r.url, referer: r.referer, cached: true };
      return { url: r.url, referer: r.referer };
    } finally {
      release(req.user.id);
    }
  });
};

// Exposed for deterministic unit testing of the cap without touching timing
// or the real extractor sidecar (see test/extract.test.js).
module.exports.tryAcquire = tryAcquire;
module.exports.release = release;
