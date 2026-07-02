"use strict";
// Per-user state sync (Phase 2). Registered at /api/state; the global
// preHandler in app.js guarantees req.user. Every query is user-scoped.
const us = require("../lib/userState");
const { createWriteLimiter } = require("../lib/writeLimiter");

module.exports = async function (fastify) {
  const limiter = createWriteLimiter();

  // navigator.sendBeacon posts text/plain — parse it as JSON. The parser is
  // scoped to this plugin's encapsulation context, so other routes are unaffected.
  fastify.addContentTypeParser("text/plain", { parseAs: "string" }, (req, body, done) => {
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (e) {
      e.statusCode = 400;
      done(e);
    }
  });

  fastify.addHook("preHandler", async (req, reply) => {
    if (req.method === "GET") return;
    if (!limiter.allow(req.user.id)) {
      return reply.code(429).send({ error: "too many writes" });
    }
  });

  const changed = (req, domain) =>
    fastify.broadcastToUser(req.user.id, "state-changed", { domain });
  const badKey = (reply, e) => {
    if (e && e.code === "BADKEY") return reply.code(400).send({ error: "bad key" });
    throw e;
  };

  fastify.get("/bootstrap", async (req) => {
    const out = us.getBootstrap(fastify.db, req.user.id);
    fastify.prewarm.schedule(req.user.id); // fire-and-forget stream pre-warm
    return out;
  });

  fastify.put("/progress/:key", async (req, reply) => {
    const pct = Number((req.body || {}).pct);
    if (!Number.isFinite(pct)) return reply.code(400).send({ error: "bad pct" });
    us.upsertProgress(fastify.db, req.user.id, req.params.key, pct);
    changed(req, "progress");
    return { ok: true };
  });

  // sendBeacon flush on tab close — fire-and-forget, no broadcast.
  fastify.post("/progress/beacon", async (req, reply) => {
    const { key, pct } = req.body || {};
    if (!key || !Number.isFinite(Number(pct))) return reply.code(400).send({ error: "bad beacon" });
    us.upsertProgress(fastify.db, req.user.id, String(key), Number(pct));
    return { ok: true };
  });

  fastify.put("/watched/:key", async (req) => {
    us.setWatched(fastify.db, req.user.id, req.params.key);
    changed(req, "watched");
    return { ok: true };
  });

  fastify.delete("/watched/:key", async (req) => {
    us.deleteWatched(fastify.db, req.user.id, req.params.key);
    changed(req, "watched");
    return { ok: true };
  });

  fastify.post("/history", async (req, reply) => {
    try {
      us.addHistory(fastify.db, req.user.id, req.body || {});
    } catch (e) {
      return badKey(reply, e);
    }
    changed(req, "history");
    return { ok: true };
  });

  fastify.delete("/history", async (req) => {
    us.clearHistory(fastify.db, req.user.id);
    changed(req, "history");
    return { ok: true };
  });

  // Static "/library/order" outranks "/library/:key" in fastify's router,
  // so "order" is never captured as a media key.
  fastify.put("/library/order", async (req) => {
    us.setLibraryOrder(fastify.db, req.user.id, (req.body || {}).keys);
    changed(req, "library");
    return { ok: true };
  });

  fastify.put("/library/:key", async (req, reply) => {
    try {
      us.upsertLibraryItem(fastify.db, req.user.id, req.params.key, req.body || {});
    } catch (e) {
      return badKey(reply, e);
    }
    changed(req, "library");
    return { ok: true };
  });

  fastify.delete("/library/:key", async (req, reply) => {
    try {
      us.deleteLibraryItem(fastify.db, req.user.id, req.params.key);
    } catch (e) {
      return badKey(reply, e);
    }
    changed(req, "library");
    return { ok: true };
  });

  fastify.put("/settings", async (req) => {
    us.setSettings(fastify.db, req.user.id, req.body || {});
    changed(req, "settings");
    return { ok: true };
  });

  fastify.post("/import", async (req) => {
    const result = us.importState(fastify.db, req.user.id, req.body || {});
    changed(req, "all");
    return result;
  });
};
