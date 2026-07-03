"use strict";
const path = require("path");
const fs = require("fs");
const { getUserById } = require("./lib/users");
const { createTmdb } = require("./lib/tmdb");
const { createRecsCache } = require("./lib/recsCache");
const { createExtractClient } = require("./lib/extract");
const { createPrewarm } = require("./lib/prewarm");
const { createCanary } = require("./lib/canary");
const { createLoginThrottle } = require("./lib/loginThrottle");

const OPEN = ["/api/login", "/api/logout", "/api/events", "/api/register", "/api/config"];

function resolveUser(fastify, req) {
  const c = req.cookies && req.cookies.sb_session;
  if (!c) return null;
  const u = fastify.unsignCookie(c);
  if (!u.valid || !u.value) return null;
  const user = getUserById(fastify.db, Number(u.value));
  return user ? { id: user.id, username: user.username, role: user.role, status: user.status } : null;
}

async function buildApp({ db, cookieSecret, loginThrottle, usernameThrottle, dataDir, distDir, tmdbFetch, extractClient, prewarm, canary }) {
  // trustProxy: behind Caddy, use the X-Forwarded-For client IP (not the
  // proxy's) so the login throttle keys on the real client. Scoped to exactly
  // one hop (the Caddy reverse_proxy in front of this app) so a client can't
  // spoof req.ip by forging a leftmost X-Forwarded-For entry. Re-verify this
  // hop count once the Cloudflare Tunnel topology is final — if cloudflared ->
  // Caddy -> app ends up being 2 hops to the app, bump this to 2.
  // NOTE: trustProxy does NOT cover the Secure-cookie decision — X-Forwarded-Proto
  // is client-spoofable regardless of hop count, so that's governed separately
  // by the STREAMBERT_SECURE_COOKIES env flag (see routes/auth.js).
  const fastify = require("fastify")({ logger: true, trustProxy: 1 });
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
  // IP-independent, username-only login throttle (I4): the per-(user,ip)
  // throttle above bounds one IP hammering one account, but an attacker
  // rotating source IPs sails past it — each IP gets its own bucket. This
  // second counter keys on the lowercased username alone, with a higher
  // threshold and longer cooldown, so distributed brute-force against a
  // single account (e.g. "admin") is still bounded. Additive: both checks
  // run in routes/auth.js, and a successful login resets both.
  fastify.decorate(
    "usernameThrottle",
    usernameThrottle !== undefined
      ? usernameThrottle
      : createLoginThrottle({ max: 20, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 }),
  );
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

  // Resolve the logged-in user for every /api/* and /vzy request; gate
  // non-open paths and 403 non-active accounts off everything but /api/me.
  fastify.addHook("preHandler", async (req, reply) => {
    const isApi = req.url.startsWith("/api/");
    const isVzy = req.url.startsWith("/vzy");
    if (!isApi && !isVzy) return;
    req.user = resolveUser(fastify, req);
    const pathOnly = req.url.split("?")[0];
    // OPEN entries are exact endpoints (no sub-paths) — match exactly, not by
    // prefix, so a future route can't collide its way past the gate.
    if (isApi && OPEN.includes(pathOnly)) return;
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
    // Pending/suspended accounts may reach only /api/me (+ /api/logout via OPEN).
    if (req.user.status !== "active" && pathOnly !== "/api/me") {
      return reply.code(403).send({ error: "account not active", status: req.user.status });
    }
  });

  // Baseline security headers on every response (defense-in-depth ahead of
  // public exposure). frame-ancestors/X-Frame-Options are skipped for /vzy —
  // those routes are the Videasy same-origin proxy and are meant to be framed
  // by the app's own player, so blocking framing there would break embedding.
  fastify.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (!req.url.startsWith("/vzy")) {
      reply.header("X-Frame-Options", "DENY");
      reply.header("Content-Security-Policy", "frame-ancestors 'none'");
    }
    return payload;
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
  // SPIKE: Videasy same-origin proxy. Off by default (C5: it serves third-party
  // JS same-origin with the session cookie — a session-riding risk not safe for
  // public exposure). Only registered when explicitly opted into; when off,
  // /vzy/* falls through to the SPA/404 (the preHandler auth gate + onSend
  // header hook above still reference the /vzy prefix, which is harmless when
  // the route itself isn't registered).
  if (process.env.STREAMBERT_VZY === "1") {
    await tryRegister("./routes/vzy", { prefix: "/vzy" });
  }

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
