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

test("admin can list and create users; non-admin gets 403", async () => {
  const { app } = await makeApp();
  const admin = await cookieFor(app, "admin", "adminpass");
  const user = await cookieFor(app, "bob", "bobpass1");

  const forbidden = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { sb_session: user } });
  assert.equal(forbidden.statusCode, 403);

  const list = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { sb_session: admin } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 2);

  const created = await app.inject({
    method: "POST", url: "/api/admin/users", cookies: { sb_session: admin },
    payload: { username: "carol", password: "carolpw1", role: "user" },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().username, "carol");
  await app.close();
});

test("duplicate username is 409; delete of last admin is 400", async () => {
  const { app } = await makeApp();
  const admin = await cookieFor(app, "admin", "adminpass");
  const dup = await app.inject({
    method: "POST", url: "/api/admin/users", cookies: { sb_session: admin },
    payload: { username: "bob", password: "another1" },
  });
  assert.equal(dup.statusCode, 409);

  const adminRow = (await app.inject({ method: "GET", url: "/api/admin/users", cookies: { sb_session: admin } }))
    .json().find((u) => u.username === "admin");
  const del = await app.inject({ method: "DELETE", url: `/api/admin/users/${adminRow.id}`, cookies: { sb_session: admin } });
  assert.equal(del.statusCode, 400);
  await app.close();
});

test("deleting a user immediately invalidates their session", async () => {
  const { app } = await makeApp();
  const admin = await cookieFor(app, "admin", "adminpass");
  const bob = await cookieFor(app, "bob", "bobpass1");
  const bobRow = (await app.inject({ method: "GET", url: "/api/admin/users", cookies: { sb_session: admin } }))
    .json().find((u) => u.username === "bob");
  await app.inject({ method: "DELETE", url: `/api/admin/users/${bobRow.id}`, cookies: { sb_session: admin } });
  const after = await app.inject({ method: "GET", url: "/api/me", cookies: { sb_session: bob } });
  assert.equal(after.statusCode, 401);
  await app.close();
});
