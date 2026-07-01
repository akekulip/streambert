"use strict";
const { getUserByUsername, verifyPassword } = require("../lib/users");

module.exports = async function (fastify) {
  fastify.post("/api/login", async (req, reply) => {
    const { username, password } = req.body || {};
    const key = `${String(username || "").toLowerCase()}|${req.ip}`;
    if (fastify.loginThrottle.isLocked(key)) {
      return reply.code(429).send({ error: "too many attempts, try again later" });
    }
    const user = username ? getUserByUsername(fastify.db, username) : null;
    const ok = user && verifyPassword(password || "", user.pw_hash, user.pw_salt);
    if (!ok) {
      fastify.loginThrottle.registerFailure(key);
      return reply.code(401).send({ error: "invalid username or password" });
    }
    fastify.loginThrottle.reset(key);
    reply.setCookie("sb_session", reply.signCookie(String(user.id)), {
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

  fastify.get("/api/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
    return { username: req.user.username, role: req.user.role };
  });
};
