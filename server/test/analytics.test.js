"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { addHistory, clearHistory } = require("../lib/userState");
const { getAnalytics } = require("../lib/analytics");
const { createCanary } = require("../lib/canary");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

const DAY = 24 * 60 * 60 * 1000;

test("watch_events log counts every watch, unlike the history snapshot", () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  // Three episodes of the same show — history upserts to 1 row, events keep 3.
  for (const ep of [1, 2, 3]) {
    addHistory(db, 1, { id: 1396, media_type: "tv", season: 1, episode: ep, watchedAt: Date.now() - ep * 1000 });
  }
  assert.equal(db.prepare("SELECT COUNT(*) c FROM history").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM watch_events").get().c, 3);
  clearHistory(db, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM watch_events").get().c, 0, "clearHistory clears events");
});

test("getAnalytics aggregates per day, per title, per user, and by type", () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  insertUser(db, { username: "bob", password: "bobpass12", role: "user" });
  const now = Date.now();
  // alice: 2 movies today, 1 tv yesterday; bob: same movie today.
  addHistory(db, 1, { id: 550, media_type: "movie", title: "Fight Club", watchedAt: now - 1000 });
  addHistory(db, 1, { id: 600, media_type: "movie", title: "Se7en", watchedAt: now - 2000 });
  addHistory(db, 1, { id: 1396, media_type: "tv", season: 1, episode: 1, title: "Breaking Bad", watchedAt: now - DAY });
  addHistory(db, 2, { id: 550, media_type: "movie", title: "Fight Club", watchedAt: now - 3000 });

  const a = getAnalytics(db, { days: 7, now });
  assert.equal(a.watchesPerDay.length, 7, "window zero-filled");
  assert.equal(a.watchesPerDay[6].count, 3, "3 watches today");
  assert.equal(a.watchesPerDay[5].count, 1, "1 watch yesterday");
  assert.equal(a.totals.watches, 4);
  assert.equal(a.totals.activeUsers7d, 2);
  assert.equal(a.topTitles[0].title, "Fight Club");
  assert.equal(a.topTitles[0].count, 2);
  assert.deepEqual(a.typeSplit, { movie: 3, tv: 1 });
  assert.equal(a.activeUsers[0].username, "alice");
  assert.equal(a.activeUsers[0].count, 3);
});

test("migration seeds watch_events from existing history rows on upgrade", () => {
  const path = require("path");
  const fs = require("fs");
  const file = path.join(os.tmpdir(), `sb-analytics-test-${process.pid}.db`);
  fs.rmSync(file, { force: true });
  const db = openDb(file);
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  addHistory(db, 1, { id: 550, media_type: "movie", watchedAt: Date.now() });
  db.prepare("DELETE FROM watch_events").run(); // simulate a pre-upgrade DB
  db.close();
  const db2 = openDb(file); // migrate() runs again, sees no events, seeds
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM watch_events").get().c, 1);
  db2.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
});

test("canary records pass/fail history with fresh extractions", async () => {
  let freshSeen = false;
  let fail = false;
  const extractClient = {
    extract: async (job, opts) => {
      freshSeen = !!(opts && opts.fresh);
      return fail ? { ok: false, status: 502, error: "extract failed" } : { ok: true, cached: false };
    },
  };
  const canary = createCanary({ extractClient, log: { warn: () => {} } });
  const first = await canary.run();
  assert.equal(first.ok, true);
  assert.equal(freshSeen, true, "canary bypasses the stream cache");
  fail = true;
  const second = await canary.run();
  assert.equal(second.ok, false);
  assert.equal(second.error, "extract failed");
  const s = canary.status();
  assert.equal(s.history.length, 2);
  assert.equal(s.passRate, 0.5);
  assert.equal(s.last.ok, false);
});

test("analytics and health endpoints are admin-gated", async () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  insertUser(db, { username: "root", password: "rootpass1", role: "admin" });
  const canary = createCanary({
    extractClient: { extract: async () => ({ ok: true, cached: false }) },
    log: { warn: () => {} },
  });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent", tmdbFetch: null, canary,
  });
  const login = async (u, p) => {
    const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } });
    return r.cookies.find((c) => c.name === "sb_session").value;
  };
  const alice = await login("alice", "alicepass");
  const root = await login("root", "rootpass1");

  for (const url of ["/api/admin/analytics", "/api/admin/health"]) {
    assert.equal((await app.inject({ method: "GET", url, cookies: { sb_session: alice } })).statusCode, 403);
  }

  addHistory(db, 1, { id: 550, media_type: "movie", title: "Fight Club", watchedAt: Date.now() });
  const a = (await app.inject({ method: "GET", url: "/api/admin/analytics?days=7", cookies: { sb_session: root } })).json();
  assert.equal(a.days, 7);
  assert.equal(a.totals.watches, 1);

  const run = await app.inject({ method: "POST", url: "/api/admin/health/canary", cookies: { sb_session: root } });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().ok, true);

  const h = (await app.inject({ method: "GET", url: "/api/admin/health", cookies: { sb_session: root } })).json();
  assert.equal(h.canary.last.ok, true);
  await app.close();
});
