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
    db,
    cookieSecret: "test-secret",
    loginThrottle: createLoginThrottle({ max: 50, lockoutMs: 1000 }),
    dataDir: os.tmpdir(),
    distDir: "/nonexistent",
  });
  return { app, db };
}

test("normal response carries baseline security headers", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "GET", url: "/api/config" });
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.ok(/frame-ancestors 'none'/.test(r.headers["content-security-policy"]));
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  await app.close();
});

test("/vzy response skips frame-blocking headers but keeps the rest", async () => {
  const { app } = await makeApp();
  // Anonymous request to /vzy is rejected by the auth gate (401) before ever
  // reaching the proxy — but it still runs through onSend, so this is a
  // deterministic way to observe the hook's behavior for /vzy paths without
  // depending on the external Videasy proxy.
  const r = await app.inject({ method: "GET", url: "/vzy/p/movie/550" });
  assert.equal(r.statusCode, 401);
  assert.equal(r.headers["x-frame-options"], undefined);
  assert.equal(r.headers["content-security-policy"], undefined);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  await app.close();
});
