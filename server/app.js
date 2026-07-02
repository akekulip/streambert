"use strict";
const path = require("path");
const fs = require("fs");
const { getUserById } = require("./lib/users");
const { createTmdb } = require("./lib/tmdb");
const { createRecsCache } = require("./lib/recsCache");
const { createExtractClient } = require("./lib/extract");
const { createPrewarm } = require("./lib/prewarm");
const { createCanary } = require("./lib/canary");

const OPEN = ["/api/login", "/api/logout", "/api/events"];

function resolveUser(fastify, req) {
  const c = req.cookies && req.cookies.sb_session;
  if (!c) return null;
  const u = fastify.unsignCookie(c);
  if (!u.valid || !u.value) return null;
  const user = getUserById(fastify.db, Number(u.value));
  return user ? { id: user.id, username: user.username, role: user.role } : null;
}

async function buildApp({ db, cookieSecret, loginThrottle, dataDir, distDir, tmdbFetch, extractClient, prewarm, canary }) {
  // trustProxy: behind Caddy, use the X-Forwarded-For client IP (not the
  // proxy's) so the login throttle keys on the real client and X-Forwarded-Proto
  // is honored for the secure-cookie decision.
  const fastify = require("fastify")({ logger: true, trustProxy: true });
  await fastify.register(require("@fastify/cookie"), { secret: cookieSecret });
  await fastify.register(require("@fastify/websocket"));
  // Brotli/gzip compression for text responses (HTML/CSS/JS/JSON). Binary/media
  // content-types (video, images) aren't compressible and are skipped, so the
  // /api/proxy media stream and downloads are unaffected.
  await fastify.register(require("@fastify/compress"), {
    global: true,
    encodings: ["br", "gzip"],
    threshold: 1024,
  });

  fastify.decorate("db", db);
  fastify.decorate("loginThrottle", loginThrottle);
  fastify.decorate("config", { DATA_DIR: dataDir });
  fastify.decorate("sessionValid", (req) => !!resolveUser(fastify, req));
  fastify.decorate("resolveUser", (req) => resolveUser(fastify, req));
  // Root-scoped so routes and admin all see them (tmdbFetch/extractClient/
  // prewarm are injectable for tests; undefined → real implementations).
  fastify.decorate("tmdbFetch", tmdbFetch !== undefined ? tmdbFetch : createTmdb({ dataDir }));
  fastify.decorate("recsCache", createRecsCache());
  fastify.decorate("extractClient", extractClient !== undefined ? extractClient : createExtractClient());
  fastify.decorate(
    "prewarm",
    prewarm !== undefined
      ? prewarm
      : createPrewarm({
          db,
          extractClient: fastify.extractClient,
          recsCache: fastify.recsCache,
          fetchTmdb: fastify.tmdbFetch,
          log: fastify.log,
        }),
  );
  // Created here but started in index.js after listen — tests never tick it.
  fastify.decorate(
    "canary",
    canary !== undefined
      ? canary
      : createCanary({ extractClient: fastify.extractClient, log: fastify.log }),
  );

  // Resolve the logged-in user for every /api/* request; gate non-open paths.
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    req.user = resolveUser(fastify, req);
    if (OPEN.some((p) => req.url.startsWith(p))) return;
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
  });

  require("./events")(fastify);
  await fastify.register(require("./routes/auth"));
  await fastify.register(require("./routes/admin"));

  // Existing route modules (unchanged). Register only if present.
  const tryRegister = async (mod, opts) => {
    let plugin;
    try { plugin = require(mod); }
    catch (e) { if (e && e.code === "MODULE_NOT_FOUND") { fastify.log.warn(`[scaffold] ${mod} missing`); return; } throw e; }
    await fastify.register(plugin, opts);
  };
  await tryRegister("./routes/secure", { prefix: "/api/secure" });
  await tryRegister("./routes/state", { prefix: "/api/state" });
  await tryRegister("./routes/recommendations", { prefix: "/api/recommendations" });
  await tryRegister("./routes/tmdb", { prefix: "/api/tmdb" });
  await tryRegister("./routes/meta", { prefix: "/api" });
  await tryRegister("./routes/allmanga", { prefix: "/api/allmanga" });
  await tryRegister("./routes/downloads", { prefix: "/api/downloads" });
  await tryRegister("./routes/files", { prefix: "/api/files" });
  await tryRegister("./routes/subtitles", { prefix: "/api/subtitles" });
  await tryRegister("./routes/wyzie", { prefix: "/api/wyzie" });
  await tryRegister("./routes/proxy", { prefix: "/api/proxy" });
  await tryRegister("./routes/extract", { prefix: "/api/extract" });

  if (distDir && fs.existsSync(distDir)) {
    await fastify.register(require("@fastify/static"), {
      root: distDir,
      prefix: "/",
      // Content-hashed files under /assets/ can be cached forever; everything
      // else (index.html) keeps the default max-age=0 so new builds are picked up.
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
  }
  fastify.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    if (distDir && fs.existsSync(path.join(distDir, "index.html"))) return reply.sendFile("index.html");
    return reply.code(503).send("frontend not built (run npm run build)");
  });

  return fastify;
}

module.exports = { buildApp, OPEN };
