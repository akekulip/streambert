"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { addHistory, upsertProgress, setWatched } = require("../lib/userState");
const { createPrewarm } = require("../lib/prewarm");
const { jobKey } = require("../lib/extract");

function makeDeps({ recs = null, tmdb = {} } = {}) {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  const extracted = [];
  const extractClient = {
    extract: async (job) => {
      extracted.push(jobKey(job));
      return { ok: true, cached: false, url: "u", referer: "r" };
    },
    isCached: () => false,
    stats: () => ({}),
  };
  const recsCache = { peek: () => recs };
  const fetchTmdb = async (p) => {
    if (p in tmdb) return tmdb[p];
    throw new Error(`no fake for ${p}`);
  };
  const prewarm = createPrewarm({
    db, extractClient, recsCache, fetchTmdb,
    log: { warn: () => {} }, delayMs: 0, gapMs: 0,
  });
  return { db, prewarm, extracted, extractClient };
}

test("warms resume points for movies and tv episodes", async () => {
  const { db, prewarm, extracted } = makeDeps();
  addHistory(db, 1, { id: 550, media_type: "movie", watchedAt: Date.now() - 2000 });
  addHistory(db, 1, { id: 1396, media_type: "tv", season: 2, episode: 3, watchedAt: Date.now() });
  upsertProgress(db, 1, "tv_1396_s2e3", 40);
  await prewarm.schedule(1);
  assert.deepEqual(extracted.sort(), ["movie:550:0:0", "tv:1396:2:3"]);
});

test("near-finished episode also warms the next episode", async () => {
  const { db, prewarm, extracted } = makeDeps({
    tmdb: { "/tv/1396/season/2": { episodes: [{ episode_number: 3 }, { episode_number: 4 }] } },
  });
  addHistory(db, 1, { id: 1396, media_type: "tv", season: 2, episode: 3, watchedAt: Date.now() });
  upsertProgress(db, 1, "tv_1396_s2e3", 92);
  await prewarm.schedule(1);
  assert.ok(extracted.includes("tv:1396:2:4"), "next episode warmed");
});

test("season end rolls over to next season's first episode", async () => {
  const { db, prewarm, extracted } = makeDeps({
    tmdb: {
      "/tv/1396/season/2": { episodes: [{ episode_number: 3 }] },
      "/tv/1396": { seasons: [{ season_number: 2 }, { season_number: 3 }] },
    },
  });
  addHistory(db, 1, { id: 1396, media_type: "tv", season: 2, episode: 3, watchedAt: Date.now() });
  upsertProgress(db, 1, "tv_1396_s2e3", 92);
  await prewarm.schedule(1);
  assert.ok(extracted.includes("tv:1396:3:1"), "next season e1 warmed");
});

test("skips watched titles, warms top recs, dedupes, and respects the cap", async () => {
  const recs = [
    { media_type: "movie", id: 900 },
    { media_type: "tv", id: 901 },
    { media_type: "movie", id: 550 }, // dup of history movie below
  ];
  const { db, prewarm, extracted } = makeDeps({ recs });
  addHistory(db, 1, { id: 550, media_type: "movie", watchedAt: Date.now() });
  addHistory(db, 1, { id: 666, media_type: "movie", watchedAt: Date.now() - 1000 });
  setWatched(db, 1, "movie_666");
  await prewarm.schedule(1);
  assert.ok(extracted.includes("movie:550:0:0"));
  assert.ok(!extracted.includes("movie:666:0:0"), "watched title not warmed");
  assert.ok(extracted.includes("movie:900:0:0"), "rec movie warmed");
  assert.ok(extracted.includes("tv:901:1:1"), "rec tv warmed as s1e1");
  assert.equal(new Set(extracted).size, extracted.length, "no duplicate jobs");
  assert.ok(extracted.length <= 6, "cap respected");
});

test("per-user cooldown prevents back-to-back runs", async () => {
  const { db, prewarm, extracted } = makeDeps();
  addHistory(db, 1, { id: 550, media_type: "movie", watchedAt: Date.now() });
  await prewarm.schedule(1);
  await prewarm.schedule(1);
  assert.equal(extracted.length, 1, "second schedule inside cooldown is a no-op");
  assert.equal(prewarm.stats().scheduled, 1);
  assert.equal(prewarm.stats().warmed, 1);
});

test("already-cached streams are skipped", async () => {
  const { db, prewarm, extracted, extractClient } = makeDeps();
  extractClient.isCached = () => true;
  addHistory(db, 1, { id: 550, media_type: "movie", watchedAt: Date.now() });
  await prewarm.schedule(1);
  assert.equal(extracted.length, 0);
  assert.equal(prewarm.stats().cachedSkips, 1);
});
