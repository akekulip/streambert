"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function makeApp({ tmdbFetch } = {}) {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent", tmdbFetch,
  });
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: "alice", password: "alicepass" } });
  return { app, cookie: r.cookies.find((c) => c.name === "sb_session").value };
}

function makeFake() {
  const fake = async (p) => {
    fake.calls.push(p);
    return { echoed: p };
  };
  fake.calls = [];
  return fake;
}

test("tmdb proxy requires auth", async () => {
  const { app } = await makeApp({ tmdbFetch: makeFake() });
  const r = await app.inject({ method: "GET", url: "/api/tmdb/movie/550" });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test("proxies allowlisted paths with query passthrough", async () => {
  const fake = makeFake();
  const { app, cookie } = await makeApp({ tmdbFetch: fake });
  const r = await app.inject({
    method: "GET",
    url: "/api/tmdb/discover/movie?with_genres=28&page=2",
    cookies: { sb_session: cookie },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().echoed, "/discover/movie?with_genres=28&page=2");
  await app.close();
});

test("non-allowlisted prefixes are 404", async () => {
  const { app, cookie } = await makeApp({ tmdbFetch: makeFake() });
  const r = await app.inject({ method: "GET", url: "/api/tmdb/account/lists", cookies: { sb_session: cookie } });
  assert.equal(r.statusCode, 404);
  await app.close();
});

test("503 without a fetcher, 502 when TMDB errors", async () => {
  const { app, cookie } = await makeApp({ tmdbFetch: null });
  const r = await app.inject({ method: "GET", url: "/api/tmdb/movie/550", cookies: { sb_session: cookie } });
  assert.equal(r.statusCode, 503);
  await app.close();

  const failing = async () => { throw new Error("TMDB 500"); };
  const { app: app2, cookie: c2 } = await makeApp({ tmdbFetch: failing });
  const r2 = await app2.inject({ method: "GET", url: "/api/tmdb/movie/550", cookies: { sb_session: c2 } });
  assert.equal(r2.statusCode, 502);
  await app2.close();
});
