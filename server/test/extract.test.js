"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");
const extractRoute = require("../routes/extract");

async function makeApp(extractClient) {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const app = await buildApp({ db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(), dataDir: os.tmpdir(), distDir: "/nonexistent", extractClient });
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  const cookie = r.cookies.find((c) => c.name === "sb_session").value;
  return { app, cookie };
}

test("extract requires auth", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "POST", url: "/api/extract/vidsrc", payload: { tmdb: "550", type: "movie" } });
  assert.equal(r.statusCode, 401);
});

test("extract calls the sidecar once, then serves from cache", async (t) => {
  let calls = 0;
  const mock = http.createServer((req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ m3u8: "https://cdn/master.m3u8?token=x", referer: "https://cdn/" }));
  });
  await new Promise((r) => mock.listen(0, r));
  t.after(() => mock.close());
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
});

// I3: per-user in-flight cap. Unit-level test of the acquire/release helper
// the route uses — deterministic, no timing games, no real sidecar involved.
test("tryAcquire/release: a second acquire for the same user is rejected until released", () => {
  const { tryAcquire, release } = extractRoute;
  const uid = "unit-test-user-" + Date.now(); // unique key so this test can't collide with others
  assert.equal(tryAcquire(uid), true, "first acquire succeeds");
  assert.equal(tryAcquire(uid), false, "second concurrent acquire is rejected");
  release(uid);
  assert.equal(tryAcquire(uid), true, "acquire succeeds again after release");
  release(uid);
});

test("release is safe to call without a matching acquire (never goes negative/leaks)", () => {
  const { tryAcquire, release } = extractRoute;
  const uid = "unit-test-user-orphan-" + Date.now();
  release(uid); // no prior acquire — must not throw or leave a bad count
  assert.equal(tryAcquire(uid), true);
  release(uid);
});

// I3: end-to-end through the real route — a second concurrent extract from
// the SAME user is 429'd while the first is still in flight, and the finally
// releases the slot so a later request (after the first resolves) succeeds.
// The extractor call itself is stubbed via buildApp's injectable extractClient
// (already used elsewhere for tests) so this is deterministic and never talks
// to the real extractor sidecar.
test("second concurrent extract from the same user gets 429; slot releases after completion", async () => {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const extractClient = {
    extract: async () => {
      await gate;
      return { ok: true, cached: false, url: "https://cdn/gated.m3u8", referer: "https://cdn/" };
    },
  };
  const { app, cookie } = await makeApp(extractClient);
  const body = { tmdb: "777099", type: "movie" };

  const firstPromise = app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: body });
  // Let the first request's handler run up to (and block on) the gate before
  // firing the second — synchronous work (tryAcquire) happens before the
  // extractClient.extract() await, so a couple of event-loop turns suffice.
  await new Promise((r) => setTimeout(r, 10));

  const second = await app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: body });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error, "extraction already in progress");

  releaseGate();
  const first = await firstPromise;
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().url, "https://cdn/gated.m3u8");

  // Slot must be released (finally) after the first request completed —
  // a subsequent request from the same user succeeds again.
  const third = await app.inject({ method: "POST", url: "/api/extract/vidsrc", cookies: { sb_session: cookie }, payload: body });
  assert.equal(third.statusCode, 200);
});
