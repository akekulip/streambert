"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function makeApp() {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const app = await buildApp({
    db, cookieSecret: "test-secret-please-change",
    loginThrottle: createLoginThrottle({ max: 3, lockoutMs: 60000 }),
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
