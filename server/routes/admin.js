"use strict";
const fs = require("fs");
const path = require("path");
const { createUser, listUsers, resetPassword, deleteUser, setUserStatus } = require("../lib/users");
const { recommend } = require("../lib/recommendations");
const { getAnalytics } = require("../lib/analytics");

module.exports = async function (fastify) {
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.user || req.user.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
  });

  fastify.get("/api/admin/users", async () => listUsers(fastify.db));

  fastify.get("/api/admin/stats", async () => {
    const count = (table) =>
      fastify.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    let dbSizeBytes = null;
    try {
      dbSizeBytes = fs.statSync(
        path.join(fastify.config.DATA_DIR, "streambert.db"),
      ).size;
    } catch {
      /* in-memory or missing DB file */
    }
    return {
      users: count("users"),
      rows: {
        history: count("history"),
        progress: count("watch_progress"),
        watched: count("watched_titles"),
        library: count("library"),
        settings: count("user_settings"),
      },
      dbSizeBytes,
      uptimeSec: Math.floor(process.uptime()),
      recsCache: {
        ...fastify.recsCache.stats(),
        tmdb: fastify.tmdbFetch && fastify.tmdbFetch.stats ? fastify.tmdbFetch.stats() : null,
      },
      streams: fastify.extractClient ? fastify.extractClient.stats() : null,
      prewarm: fastify.prewarm ? fastify.prewarm.stats() : null,
    };
  });

  fastify.get("/api/admin/users/:id/summary", async (req, reply) => {
    const userId = Number(req.params.id);
    const one = (sql) => fastify.db.prepare(sql).get(userId);
    const exists = fastify.db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
    if (!exists) return reply.code(404).send({ error: "no such user" });
    return {
      history: one("SELECT COUNT(*) AS c, MAX(watched_at) AS last FROM history WHERE user_id = ?"),
      progress: one("SELECT COUNT(*) AS c, MAX(updated_at) AS last FROM watch_progress WHERE user_id = ?"),
      watched: one("SELECT COUNT(*) AS c FROM watched_titles WHERE user_id = ?"),
      library: one("SELECT COUNT(*) AS c FROM library WHERE user_id = ?"),
    };
  });

  // Preview what the recommendation engine would serve a user right now.
  fastify.get("/api/admin/users/:id/recommendations", async (req, reply) => {
    const tmdb = fastify.tmdbFetch;
    if (!tmdb || (tmdb.hasToken && !tmdb.hasToken())) {
      return reply.code(503).send({ error: "tmdb token not configured" });
    }
    const userId = Number(req.params.id);
    const history = fastify.db
      .prepare(
        "SELECT media_type, tmdb_id, watched_at FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 500",
      )
      .all(userId);
    const results = await recommend({ history, fetchTmdb: tmdb, limit: 12 });
    return {
      results: results.map((r) => ({
        media_type: r.media_type,
        id: r.id,
        title: r.title || r.name || String(r.id),
        poster_path: r.poster_path || null,
        vote_average: r.vote_average,
      })),
    };
  });

  fastify.get("/api/admin/analytics", async (req) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    return getAnalytics(fastify.db, { days });
  });

  fastify.get("/api/admin/health", async () => ({
    canary: fastify.canary ? fastify.canary.status() : null,
    streams: fastify.extractClient ? fastify.extractClient.stats() : null,
  }));

  fastify.post("/api/admin/health/canary", async () => fastify.canary.run());

  fastify.post("/api/admin/recs-cache/purge", async () => {
    fastify.recsCache.clear();
    if (fastify.tmdbFetch && fastify.tmdbFetch.clear) fastify.tmdbFetch.clear();
    return { ok: true };
  });

  fastify.post("/api/admin/users", async (req, reply) => {
    const { username, password, role } = req.body || {};
    try {
      return createUser(fastify.db, { username, password, role: role === "admin" ? "admin" : "user" });
    } catch (e) {
      if (e.code === "DUP") return reply.code(409).send({ error: "username taken" });
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.post("/api/admin/users/:id/reset-password", async (req, reply) => {
    try {
      resetPassword(fastify.db, Number(req.params.id), (req.body || {}).password);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.post("/api/admin/users/:id/activate", async (req, reply) => {
    try { setUserStatus(fastify.db, Number(req.params.id), "active"); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  fastify.post("/api/admin/users/:id/suspend", async (req, reply) => {
    try { setUserStatus(fastify.db, Number(req.params.id), "disabled"); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  fastify.delete("/api/admin/users/:id", async (req, reply) => {
    try {
      deleteUser(fastify.db, Number(req.params.id));
      return { ok: true };
    } catch (e) {
      if (e.code === "LAST_ADMIN") return reply.code(400).send({ error: "cannot delete the last admin" });
      return reply.code(400).send({ error: e.message });
    }
  });
};
