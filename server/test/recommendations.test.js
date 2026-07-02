"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { addHistory } = require("../lib/userState");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

// Fake TMDB: every title's /recommendations returns three follow-ups derived
// from its id, so results are predictable. Counts calls for cache assertions.
function makeFakeTmdb() {
  const fake = async (p) => {
    fake.calls.push(p);
    const m = p.match(/^\/(movie|tv)\/(\d+)\/recommendations$/);
    if (m) {
      const base = Number(m[2]);
      return {
        results: [1, 2, 3].map((k) => ({
          id: base * 10 + k,
          title: `rec-${base}-${k}`,
          poster_path: `/p${base}${k}.jpg`,
          vote_average: 7,
        })),
      };
    }
    return { results: [] };
  };
  fake.calls = [];
  return fake;
}

async function makeApp({ tmdbFetch } = {}) {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  insertUser(db, { username: "root", password: "rootpass1", role: "admin" });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent",
    tmdbFetch: tmdbFetch !== undefined ? tmdbFetch : makeFakeTmdb(),
  });
  return { app, db };
}
async function cookieFor(app, username, password) {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  return r.cookies.find((c) => c.name === "sb_session").value;
}
// Timestamps must be recent — the engine only seeds from the last 30 days.
function seedHistory(db, userId, ids) {
  const base = Date.now() - ids.length * 1000;
  ids.forEach((id, i) =>
    addHistory(db, userId, { id, media_type: "movie", title: `t${id}`, watchedAt: base + i * 1000 }),
  );
}

test("unauthenticated recommendations access is 401", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "GET", url: "/api/recommendations" });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test("returns engine results with full item fields, excluding watched", async () => {
  const { app, db } = await makeApp();
  seedHistory(db, 1, [50, 60, 70]);
  const alice = await cookieFor(app, "alice", "alicepass");
  const r = await app.inject({ method: "GET", url: "/api/recommendations", cookies: { sb_session: alice } });
  assert.equal(r.statusCode, 200);
  const { results } = r.json();
  assert.ok(results.length > 0);
  assert.ok(results[0].title, "items carry render fields");
  assert.ok(results[0].poster_path, "items carry poster_path");
  // Newest seed is 70 → its recs lead the row.
  assert.equal(results[0].id, 701);
  const ids = new Set(results.map((i) => i.id));
  for (const watched of [50, 60, 70]) assert.ok(!ids.has(watched), "watched titles excluded");
  await app.close();
});

test("empty history returns empty results without TMDB calls", async () => {
  const fake = makeFakeTmdb();
  const { app } = await makeApp({ tmdbFetch: fake });
  const alice = await cookieFor(app, "alice", "alicepass");
  const r = await app.inject({ method: "GET", url: "/api/recommendations", cookies: { sb_session: alice } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().results, []);
  assert.equal(fake.calls.length, 0);
  await app.close();
});

test("503 when no TMDB fetcher is configured", async () => {
  const { app, db } = await makeApp({ tmdbFetch: null });
  seedHistory(db, 1, [50]);
  const alice = await cookieFor(app, "alice", "alicepass");
  const r = await app.inject({ method: "GET", url: "/api/recommendations", cookies: { sb_session: alice } });
  assert.equal(r.statusCode, 503);
  await app.close();
});

test("results are cached per user and busted by a new history write", async () => {
  const fake = makeFakeTmdb();
  const { app, db } = await makeApp({ tmdbFetch: fake });
  seedHistory(db, 1, [50, 60]);
  const alice = await cookieFor(app, "alice", "alicepass");
  const url = { method: "GET", url: "/api/recommendations", cookies: { sb_session: alice } };

  await app.inject(url);
  const callsAfterFirst = fake.calls.length;
  await app.inject(url);
  assert.equal(fake.calls.length, callsAfterFirst, "second request served from cache");

  addHistory(db, 1, { id: 70, media_type: "movie", title: "t70", watchedAt: Date.now() });
  const r = await app.inject(url);
  assert.ok(fake.calls.length > callsAfterFirst, "new history busts the cache");
  assert.equal(r.json().results[0].id, 701, "new newest seed leads the row");
  await app.close();
});

test("admin stats/summary/preview are admin-gated and consistent", async () => {
  const { app, db } = await makeApp();
  seedHistory(db, 1, [50, 60]);
  const alice = await cookieFor(app, "alice", "alicepass");
  const root = await cookieFor(app, "root", "rootpass1");

  for (const url of ["/api/admin/stats", "/api/admin/users/1/summary", "/api/admin/users/1/recommendations"]) {
    const r = await app.inject({ method: "GET", url, cookies: { sb_session: alice } });
    assert.equal(r.statusCode, 403, `${url} forbidden for non-admin`);
  }

  const stats = (await app.inject({ method: "GET", url: "/api/admin/stats", cookies: { sb_session: root } })).json();
  assert.equal(stats.users, 2);
  assert.equal(stats.rows.history, 2);
  assert.ok(stats.uptimeSec >= 0);

  const summary = (await app.inject({ method: "GET", url: "/api/admin/users/1/summary", cookies: { sb_session: root } })).json();
  assert.equal(summary.history.c, 2);
  assert.ok(summary.history.last > 0);

  const missing = await app.inject({ method: "GET", url: "/api/admin/users/999/summary", cookies: { sb_session: root } });
  assert.equal(missing.statusCode, 404);

  const preview = (await app.inject({ method: "GET", url: "/api/admin/users/1/recommendations", cookies: { sb_session: root } })).json();
  assert.ok(preview.results.length > 0);
  assert.ok(preview.results[0].title.startsWith("rec-"), "preview carries titles");

  const purge = await app.inject({ method: "POST", url: "/api/admin/recs-cache/purge", cookies: { sb_session: root } });
  assert.equal(purge.statusCode, 200);
  await app.close();
});
