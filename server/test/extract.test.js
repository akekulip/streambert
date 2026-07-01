"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function makeApp() {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const app = await buildApp({ db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(), dataDir: os.tmpdir(), distDir: "/nonexistent" });
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  const cookie = r.cookies.find((c) => c.name === "sb_session").value;
  return { app, cookie };
}

test("extract requires auth", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "POST", url: "/api/extract/vidsrc", payload: { tmdb: "550", type: "movie" } });
  assert.equal(r.statusCode, 401);
});

test("extract calls the sidecar once, then serves from cache", async () => {
  let calls = 0;
  const mock = http.createServer((req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ m3u8: "https://cdn/master.m3u8?token=x", referer: "https://cdn/" }));
  });
  await new Promise((r) => mock.listen(0, r));
  process.env.STREAMBERT_EXTRACTOR_URL = `http://127.0.0.1:${mock.address().port}`;

  const { app, cookie } = await makeApp();
  const body = { tmdb: "777001", type: "movie" }; // unique tmdb -> no cross-test cache hit
  const first = await app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: body });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().url, "https://cdn/master.m3u8?token=x");
  assert.equal(first.json().referer, "https://cdn/");

  const second = await app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: body });
  assert.equal(second.json().cached, true);
  assert.equal(calls, 1, "sidecar called once; second served from cache");

  const bad = await app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: { type: "movie" } });
  assert.equal(bad.statusCode, 400);
  mock.close();
});
