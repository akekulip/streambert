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
  insertUser(db, { username: "bob", password: "bobpass1", role: "user" });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent",
  });
  return { app, db };
}
async function cookieFor(app, username, password) {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  return r.cookies.find((c) => c.name === "sb_session").value;
}

test("non-admin cannot PUT the shared secure store; admin can PUT and GET", async () => {
  const { app } = await makeApp();
  const admin = await cookieFor(app, "admin", "adminpass");
  const user = await cookieFor(app, "bob", "bobpass1");

  const forbidden = await app.inject({
    method: "PUT", url: "/api/secure/apikey", cookies: { sb_session: user },
    payload: { value: "attacker-token" },
  });
  assert.equal(forbidden.statusCode, 403);

  const put = await app.inject({
    method: "PUT", url: "/api/secure/apikey", cookies: { sb_session: admin },
    payload: { value: "admin-token" },
  });
  assert.equal(put.statusCode, 200);

  const get = await app.inject({ method: "GET", url: "/api/secure/apikey", cookies: { sb_session: admin } });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().value, "admin-token");
  await app.close();
});
