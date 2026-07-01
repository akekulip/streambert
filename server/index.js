"use strict";
// Streambert web-port backend. Serves the built frontend (../dist) + /api/*.
// Auth: single shared password -> signed HTTP-only cookie. See docs/WEB_PORT.md.

const path = require("path");
const fastify = require("fastify")({ logger: true });

const PASSWORD = process.env.STREAMBERT_PASSWORD || "";
const COOKIE_SECRET =
  process.env.STREAMBERT_COOKIE_SECRET || "streambert-dev-secret-change-me";
const DIST_DIR = path.join(__dirname, "..", "dist");
const DATA_DIR =
  process.env.STREAMBERT_DATA || path.join(__dirname, "..", "data");
const PORT = Number(process.env.PORT || 8787);

// Paths that skip the auth gate.
const OPEN = ["/api/login", "/api/logout", "/api/events"];

function sessionValid(fastify, req) {
  const c = req.cookies && req.cookies.sb_session;
  if (!c) return false;
  const u = fastify.unsignCookie(c);
  return u.valid && u.value === "ok";
}

// Register a route module if it exists yet; otherwise log and continue.
// Lets specialist agents fill in server/routes/* incrementally.
async function tryRegister(mod, opts) {
  let plugin;
  try {
    plugin = require(mod);
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND") {
      fastify.log.warn(`[scaffold] ${mod} not implemented yet — skipping`);
      return;
    }
    throw e;
  }
  await fastify.register(plugin, opts);
}

async function main() {
  await fastify.register(require("@fastify/cookie"), { secret: COOKIE_SECRET });
  await fastify.register(require("@fastify/websocket"));

  fastify.decorate("config", { DATA_DIR, PASSWORD });
  fastify.decorate("sessionValid", (req) => sessionValid(fastify, req));

  // Auth gate for /api/* (login/logout/events excepted; events checks the cookie itself).
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (OPEN.some((p) => req.url.startsWith(p))) return;
    if (!sessionValid(fastify, req))
      return reply.code(401).send({ error: "unauthorized" });
  });

  fastify.post("/api/login", async (req, reply) => {
    const { password } = req.body || {};
    if (!PASSWORD || password !== PASSWORD)
      return reply.code(401).send({ error: "bad password" });
    reply.setCookie("sb_session", reply.signCookie("ok"), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: req.headers["x-forwarded-proto"] === "https",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });
  fastify.post("/api/logout", async (_req, reply) => {
    reply.clearCookie("sb_session", { path: "/" });
    return { ok: true };
  });

  // WS event hub (/api/events).
  require("./events")(fastify);

  // API route modules (each owned by one agent — see docs/WEB_PORT.md).
  await tryRegister("./routes/secure", { prefix: "/api/secure" });
  await tryRegister("./routes/meta", { prefix: "/api" });
  await tryRegister("./routes/allmanga", { prefix: "/api/allmanga" });
  await tryRegister("./routes/downloads", { prefix: "/api/downloads" });
  await tryRegister("./routes/files", { prefix: "/api/files" });
  await tryRegister("./routes/subtitles", { prefix: "/api/subtitles" });
  await tryRegister("./routes/wyzie", { prefix: "/api/wyzie" });
  await tryRegister("./routes/proxy", { prefix: "/api/proxy" });

  // Static frontend + SPA fallback.
  const fs = require("fs");
  if (fs.existsSync(DIST_DIR)) {
    await fastify.register(require("@fastify/static"), {
      root: DIST_DIR,
      prefix: "/",
    });
  }
  fastify.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith("/api/"))
      return reply.code(404).send({ error: "not found" });
    if (fs.existsSync(path.join(DIST_DIR, "index.html")))
      return reply.sendFile("index.html");
    return reply.code(503).send("frontend not built (run npm run build)");
  });

  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  fastify.log.info(`Streambert web on :${PORT}`);
}

main().catch((e) => {
  fastify.log.error(e);
  process.exit(1);
});
