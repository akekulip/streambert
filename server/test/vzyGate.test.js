"use strict";
// C5: /vzy (Videasy same-origin proxy) must be gated behind STREAMBERT_VZY,
// off by default. These tests build the app with the flag unset/"1"/"0" and
// assert the route is (not) actually registered — using an in-plugin path
// ("/vzy/x/foo", an unrecognized host key that 404s from inside routes/vzy.js
// without any outbound fetch) so the "registered" case stays deterministic
// and network-free. GET /vzy/p/movie/550 is also checked directly per the
// task brief, but only with the flag unset, so no live request ever reaches
// player.videasy.to.
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
  return app;
}

async function loginCookie(app) {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  return r.cookies.find((c) => c.name === "sb_session").value;
}

function withEnv(value, fn) {
  const prev = process.env.STREAMBERT_VZY;
  if (value === undefined) delete process.env.STREAMBERT_VZY;
  else process.env.STREAMBERT_VZY = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.STREAMBERT_VZY;
    else process.env.STREAMBERT_VZY = prev;
  });
}

test("STREAMBERT_VZY unset: /vzy/p/movie/550 is not proxied (falls through to SPA/404)", () =>
  withEnv(undefined, async () => {
    const app = await makeApp();
    const cookie = await loginCookie(app);
    const r = await app.inject({ method: "GET", url: "/vzy/p/movie/550", cookies: { sb_session: cookie } });
    // No dist build present in this test → the SPA-fallback 404/503, never a
    // videasy-proxied response.
    assert.notEqual(r.statusCode, 200);
    assert.ok(!/videasy/i.test(r.body));
    await app.close();
  }));

test("STREAMBERT_VZY unset: /vzy route is not registered (unknown-host path hits the SPA fallback, not routes/vzy.js)", () =>
  withEnv(undefined, async () => {
    const app = await makeApp();
    const cookie = await loginCookie(app);
    const r = await app.inject({ method: "GET", url: "/vzy/x/foo", cookies: { sb_session: cookie } });
    assert.notEqual(r.body, "unknown videasy host");
    await app.close();
  }));

test('STREAMBERT_VZY="1": /vzy route registers (unknown-host path 404s from inside routes/vzy.js)', () =>
  withEnv("1", async () => {
    const app = await makeApp();
    const cookie = await loginCookie(app);
    const r = await app.inject({ method: "GET", url: "/vzy/x/foo", cookies: { sb_session: cookie } });
    assert.equal(r.statusCode, 404);
    assert.equal(r.body, "unknown videasy host");
    await app.close();
  }));

test('STREAMBERT_VZY="0": treated the same as unset (route not registered)', () =>
  withEnv("0", async () => {
    const app = await makeApp();
    const cookie = await loginCookie(app);
    const r = await app.inject({ method: "GET", url: "/vzy/x/foo", cookies: { sb_session: cookie } });
    assert.notEqual(r.body, "unknown videasy host");
    await app.close();
  }));

test("anonymous /vzy request is still 401 regardless of the flag (auth gate is independent of route registration)", () =>
  withEnv(undefined, async () => {
    const app = await makeApp();
    const r = await app.inject({ method: "GET", url: "/vzy/p/movie/550" });
    assert.equal(r.statusCode, 401);
    await app.close();
  }));

test("GET /api/config reports vzy:false when unset, vzy:true when STREAMBERT_VZY=1", () =>
  withEnv(undefined, async () => {
    const app = await makeApp();
    const off = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(off.json().vzy, false);
    await app.close();
  }).then(() =>
    withEnv("1", async () => {
      const app = await makeApp();
      const on = await app.inject({ method: "GET", url: "/api/config" });
      assert.equal(on.json().vzy, true);
      await app.close();
    }),
  ));

test("GET /api/config reports extractor per STREAMBERT_EXTRACTOR_URL", async () => {
  const prev = process.env.STREAMBERT_EXTRACTOR_URL;
  try {
    delete process.env.STREAMBERT_EXTRACTOR_URL;
    let app = await makeApp();
    let r = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(r.json().extractor, false);
    await app.close();

    process.env.STREAMBERT_EXTRACTOR_URL = "http://streambert-extractor:8788";
    app = await makeApp();
    r = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(r.json().extractor, true);
    await app.close();
  } finally {
    if (prev === undefined) delete process.env.STREAMBERT_EXTRACTOR_URL;
    else process.env.STREAMBERT_EXTRACTOR_URL = prev;
  }
});
