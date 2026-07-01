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
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  insertUser(db, { username: "bob", password: "bobpass12", role: "user" });
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

test("unauthenticated state access is 401", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "GET", url: "/api/state/bootstrap" });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test("/api/me includes the user id", async () => {
  const { app } = await makeApp();
  const alice = await cookieFor(app, "alice", "alicepass");
  const me = await app.inject({ method: "GET", url: "/api/me", cookies: { sb_session: alice } });
  assert.equal(me.statusCode, 200);
  assert.equal(typeof me.json().id, "number");
  assert.equal(me.json().username, "alice");
  await app.close();
});

test("state writes round-trip through bootstrap and are user-isolated", async () => {
  const { app } = await makeApp();
  const alice = await cookieFor(app, "alice", "alicepass");
  const bob = await cookieFor(app, "bob", "bobpass12");

  await app.inject({ method: "PUT", url: "/api/state/progress/movie_550", cookies: { sb_session: alice }, payload: { pct: 42 } });
  await app.inject({ method: "PUT", url: "/api/state/watched/movie_550", cookies: { sb_session: alice }, payload: {} });
  await app.inject({
    method: "POST", url: "/api/state/history", cookies: { sb_session: alice },
    payload: { id: 550, media_type: "movie", title: "Fight Club", poster_path: "/f.jpg", season: null, episode: null, episodeName: null, watchedAt: 1234 },
  });
  await app.inject({
    method: "PUT", url: "/api/state/library/movie_550", cookies: { sb_session: alice },
    payload: { id: 550, title: "Fight Club", poster_path: "/f.jpg", media_type: "movie", vote_average: 8.4, year: "1999" },
  });
  await app.inject({ method: "PUT", url: "/api/state/settings", cookies: { sb_session: alice }, payload: { accentColor: "blue" } });

  const boot = (await app.inject({ method: "GET", url: "/api/state/bootstrap", cookies: { sb_session: alice } })).json();
  assert.equal(boot.progress.movie_550, 42);
  assert.equal(boot.watched.movie_550, true);
  assert.equal(boot.history[0].title, "Fight Club");
  assert.deepEqual(boot.libraryOrder, ["movie_550"]);
  assert.equal(boot.settings.accentColor, "blue");

  const bobBoot = (await app.inject({ method: "GET", url: "/api/state/bootstrap", cookies: { sb_session: bob } })).json();
  assert.deepEqual(bobBoot.progress, {});
  assert.deepEqual(bobBoot.library, {});
  await app.close();
});

test("watched DELETE, library DELETE and order rewrite work", async () => {
  const { app } = await makeApp();
  const alice = await cookieFor(app, "alice", "alicepass");
  await app.inject({ method: "PUT", url: "/api/state/watched/movie_1", cookies: { sb_session: alice }, payload: {} });
  await app.inject({ method: "DELETE", url: "/api/state/watched/movie_1", cookies: { sb_session: alice } });
  for (const k of ["movie_1", "movie_2"]) {
    await app.inject({
      method: "PUT", url: `/api/state/library/${k}`, cookies: { sb_session: alice },
      payload: { id: Number(k.split("_")[1]), title: k, poster_path: null, media_type: "movie", vote_average: 5, year: "2000" },
    });
  }
  await app.inject({ method: "PUT", url: "/api/state/library/order", cookies: { sb_session: alice }, payload: { keys: ["movie_2", "movie_1"] } });
  await app.inject({ method: "DELETE", url: "/api/state/library/movie_1", cookies: { sb_session: alice } });
  const boot = (await app.inject({ method: "GET", url: "/api/state/bootstrap", cookies: { sb_session: alice } })).json();
  assert.deepEqual(boot.watched, {});
  assert.deepEqual(boot.libraryOrder, ["movie_2"]);
  await app.close();
});

test("beacon accepts a text/plain JSON body (sendBeacon)", async () => {
  const { app } = await makeApp();
  const alice = await cookieFor(app, "alice", "alicepass");
  const r = await app.inject({
    method: "POST", url: "/api/state/progress/beacon", cookies: { sb_session: alice },
    headers: { "content-type": "text/plain;charset=UTF-8" },
    payload: JSON.stringify({ key: "movie_9", pct: 77 }),
  });
  assert.equal(r.statusCode, 200);
  const boot = (await app.inject({ method: "GET", url: "/api/state/bootstrap", cookies: { sb_session: alice } })).json();
  assert.equal(boot.progress.movie_9, 77);
  await app.close();
});

test("import returns the merged bootstrap", async () => {
  const { app } = await makeApp();
  const alice = await cookieFor(app, "alice", "alicepass");
  await app.inject({ method: "PUT", url: "/api/state/progress/movie_1", cookies: { sb_session: alice }, payload: { pct: 10 } });
  const r = await app.inject({
    method: "POST", url: "/api/state/import", cookies: { sb_session: alice },
    payload: {
      progress: { movie_1: 55 }, watched: { movie_1: true },
      history: [], saved: {}, savedOrder: null, settings: { ageLimit: 16 },
    },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().progress.movie_1, 55);
  assert.equal(r.json().watched.movie_1, true);
  assert.equal(r.json().settings.ageLimit, 16);
  await app.close();
});

test("invalid pct and bad library key are 400", async () => {
  const { app } = await makeApp();
  const alice = await cookieFor(app, "alice", "alicepass");
  const badPct = await app.inject({ method: "PUT", url: "/api/state/progress/movie_1", cookies: { sb_session: alice }, payload: { pct: "nope" } });
  assert.equal(badPct.statusCode, 400);
  const badKey = await app.inject({ method: "PUT", url: "/api/state/library/junk", cookies: { sb_session: alice }, payload: { id: 1 } });
  assert.equal(badKey.statusCode, 400);
  await app.close();
});

test("write rate limit returns 429 past 120 writes/min", async () => {
  const { app } = await makeApp();
  const alice = await cookieFor(app, "alice", "alicepass");
  let last;
  for (let i = 0; i < 125; i++) {
    last = await app.inject({ method: "PUT", url: "/api/state/progress/movie_1", cookies: { sb_session: alice }, payload: { pct: i } });
  }
  assert.equal(last.statusCode, 429);
  // GETs are never limited
  const boot = await app.inject({ method: "GET", url: "/api/state/bootstrap", cookies: { sb_session: alice } });
  assert.equal(boot.statusCode, 200);
  await app.close();
});
