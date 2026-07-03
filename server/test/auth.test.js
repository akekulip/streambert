"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function makeApp({ usernameThrottle } = {}) {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const app = await buildApp({
    db, cookieSecret: "test-secret-please-change",
    loginThrottle: createLoginThrottle({ max: 3, lockoutMs: 60000 }),
    usernameThrottle,
    dataDir: os.tmpdir(), distDir: "/nonexistent-dist",
  });
  return { app, db };
}

test("login rejects bad credentials and accepts good ones", async () => {
  const { app } = await makeApp();
  const bad = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "wrong" } });
  assert.equal(bad.statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.cookies.find((c) => c.name === "sb_session"));
  await app.close();
});

test("login for a non-existent username is rejected the same as a bad password", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { username: "ghost", password: "whatever" } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid username or password");
  assert.equal(res.cookies.find((c) => c.name === "sb_session"), undefined);
  await app.close();
});

test("/api/me is 401 without a session and returns the user with one", async () => {
  const { app } = await makeApp();
  const anon = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(anon.statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  const cookie = login.cookies.find((c) => c.name === "sb_session").value;
  const me = await app.inject({ method: "GET", url: "/api/me", cookies: { sb_session: cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().username, "admin");
  assert.equal(me.json().role, "admin");
  await app.close();
});

test("throttle returns 429 after too many failures", async () => {
  const { app } = await makeApp();
  for (let i = 0; i < 3; i++) {
    await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "wrong" } });
  }
  const locked = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  assert.equal(locked.statusCode, 429);
  await app.close();
});

// I4: username-scoped throttle is IP-independent — a distributed attacker
// rotating source IPs still trips it. trustProxy is 1 (see app.js), so
// app.inject's X-Forwarded-For header drives req.ip deterministically here;
// each failure below comes from a distinct simulated IP, so the existing
// per-(user,ip) throttle (max 3, same key only on repeat) never fires — only
// the username-only counter can be responsible for the 429.
test("username-scoped throttle locks 'admin' after 20 failures across different IPs, even from a fresh IP", async () => {
  const usernameThrottle = createLoginThrottle({ max: 20, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 });
  const { app } = await makeApp({ usernameThrottle });

  for (let i = 0; i < 20; i++) {
    const r = await app.inject({
      method: "POST", url: "/api/login",
      headers: { "x-forwarded-for": `10.0.0.${i}` },
      payload: { username: "admin", password: "wrong" },
    });
    assert.equal(r.statusCode, 401);
  }

  // 21st attempt: brand-new IP never seen before, correct password — still
  // locked out because the username-only counter (not per-IP) has tripped.
  const locked = await app.inject({
    method: "POST", url: "/api/login",
    headers: { "x-forwarded-for": "10.0.1.1" },
    payload: { username: "admin", password: "adminpass" },
  });
  assert.equal(locked.statusCode, 429);
  await app.close();
});

test("a successful login resets the username-scoped throttle (not just the per-IP one)", async () => {
  const usernameThrottle = createLoginThrottle({ max: 2, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 });
  const { app } = await makeApp({ usernameThrottle });

  // 1 failure from IP A (count=1, below max=2 -> not locked yet)
  await app.inject({
    method: "POST", url: "/api/login",
    headers: { "x-forwarded-for": "10.9.0.1" },
    payload: { username: "admin", password: "wrong" },
  });

  // Successful login from a different IP resets the username-scoped counter.
  const ok = await app.inject({
    method: "POST", url: "/api/login",
    headers: { "x-forwarded-for": "10.9.0.2" },
    payload: { username: "admin", password: "adminpass" },
  });
  assert.equal(ok.statusCode, 200);

  // If the reset hadn't happened, this next failure would be #2 (>= max) and
  // lock the account. Since it was reset, this is only failure #1 again, so a
  // subsequent correct login from yet another IP still succeeds.
  await app.inject({
    method: "POST", url: "/api/login",
    headers: { "x-forwarded-for": "10.9.0.3" },
    payload: { username: "admin", password: "wrong" },
  });
  const stillOk = await app.inject({
    method: "POST", url: "/api/login",
    headers: { "x-forwarded-for": "10.9.0.4" },
    payload: { username: "admin", password: "adminpass" },
  });
  assert.equal(stillOk.statusCode, 200);
  await app.close();
});
