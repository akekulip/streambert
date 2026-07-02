"use strict";
// Personalised recommendations (engine v2, autoresearch winner). Registered at
// /api/recommendations; the global preHandler in app.js guarantees req.user.
// History comes from the per-user SQLite tables (Phase 2), TMDB data through
// fastify.tmdbFetch, results through the shared per-user cache.

const { recommend } = require("../lib/recommendations");

const HISTORY_LIMIT = 500;
const ROW_LIMIT = 20;

module.exports = async function (fastify) {
  fastify.get("/", async (req, reply) => {
    const tmdb = fastify.tmdbFetch;
    if (!tmdb || (tmdb.hasToken && !tmdb.hasToken())) {
      return reply.code(503).send({ error: "tmdb token not configured" });
    }
    const history = fastify.db
      .prepare(
        "SELECT media_type, tmdb_id, watched_at FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT ?",
      )
      .all(req.user.id, HISTORY_LIMIT);
    if (history.length === 0) return { results: [] };

    const newest = history[0].watched_at;
    const cached = fastify.recsCache.lookup(req.user.id, newest);
    if (cached) return { results: cached };

    const results = await recommend({
      history,
      fetchTmdb: tmdb,
      limit: ROW_LIMIT,
    });
    fastify.recsCache.store(req.user.id, newest, results);
    return { results };
  });
};
