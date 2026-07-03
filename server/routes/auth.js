"use strict";
const { getUserByUsername, verifyPassword, registerUser } = require("../lib/users");
const { hashPassword } = require("../lib/passwords");

// A fixed dummy credential so that an unknown username still incurs the full
// scrypt cost. Without it, a miss returns near-instantly while a real user with
// a wrong password pays for scrypt — a timing side-channel that leaks which
// usernames exist. Verifying against DUMMY on the miss path keeps login
// constant-time regardless of whether the username exists.
const DUMMY = hashPassword("streambert-constant-time-dummy");

module.exports = async function (fastify) {
  fastify.post("/api/login", async (req, reply) => {
    const { username, password } = req.body || {};
    const uname = String(username || "").toLowerCase();
    const key = `${uname}|${req.ip}`;
    // Two independent throttles: per-(user,ip) bounds one IP hammering one
    // account; per-username (I4) bounds an attacker rotating source IPs
    // against the same account — check both before doing any password work.
    if (fastify.loginThrottle.isLocked(key) || fastify.usernameThrottle.isLocked(uname)) {
      return reply.code(429).send({ error: "too many attempts, try again later" });
    }
    const user = username ? getUserByUsername(fastify.db, username) : null;
    // Always call verifyPassword (against DUMMY when the user is unknown) so the
    // work is identical whether or not the username exists — do NOT let `&&`
    // short-circuit past the scrypt call.
    const hashOk = verifyPassword(
      password || "",
      user ? user.pw_hash : DUMMY.hash,
      user ? user.pw_salt : DUMMY.salt,
    );
    const ok = !!user && hashOk;
    if (!ok) {
      fastify.loginThrottle.registerFailure(key);
      fastify.usernameThrottle.registerFailure(uname);
      return reply.code(401).send({ error: "invalid username or password" });
    }
    fastify.loginThrottle.reset(key);
    fastify.usernameThrottle.reset(uname);
    reply.setCookie("sb_session", reply.signCookie(String(user.id)), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Force Secure in production via an explicit opt-in flag; the
      // x-forwarded-proto header is client-controllable (a client can send
      // `x-forwarded-proto: http` to strip the Secure attribute) so it's only
      // trusted as a fallback for dev/LAN deployments that don't set the flag.
      secure: process.env.STREAMBERT_SECURE_COOKIES === "1" ||
        req.headers["x-forwarded-proto"] === "https",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

  fastify.post("/api/register", async (req, reply) => {
    const key = `register-throttle:${req.ip}`;
    if (fastify.loginThrottle.isLocked(key)) {
      return reply.code(429).send({ error: "too many attempts, try again later" });
    }
    const { identifier, password } = req.body || {};
    try {
      registerUser(fastify.db, { identifier, password });
      fastify.loginThrottle.registerFailure(key); // count every attempt toward the per-IP cap
      return { ok: true, status: "pending" };
    } catch (e) {
      if (e.code === "DUP") { fastify.loginThrottle.registerFailure(key); return reply.code(409).send({ error: "that email or phone is already registered" }); }
      if (e.code === "BADINPUT") { fastify.loginThrottle.registerFailure(key); return reply.code(400).send({ error: e.message }); }
      throw e; // genuine server error — do not count toward lockout
    }
  });

  fastify.post("/api/logout", async (_req, reply) => {
    reply.clearCookie("sb_session", { path: "/" });
    return { ok: true };
  });

  fastify.get("/api/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
    return { id: req.user.id, username: req.user.username, role: req.user.role, status: req.user.status };
  });
};
