"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const us = require("../lib/userState");

function makeDb() {
  const db = openDb(":memory:");
  const a = insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  const b = insertUser(db, { username: "bob", password: "bobpass12", role: "user" });
  return { db, a: a.id, b: b.id };
}

test("bootstrap of a fresh user returns empty shapes", () => {
  const { db, a } = makeDb();
  const boot = us.getBootstrap(db, a);
  assert.deepEqual(boot.progress, {});
  assert.deepEqual(boot.watched, {});
  assert.deepEqual(boot.history, []);
  assert.deepEqual(boot.library, {});
  assert.equal(boot.libraryOrder, null);
  assert.deepEqual(boot.settings, {});
});

test("progress upsert is last-write-wins and user-scoped", () => {
  const { db, a, b } = makeDb();
  us.upsertProgress(db, a, "movie_550", 12.5);
  us.upsertProgress(db, a, "movie_550", 40);
  us.upsertProgress(db, a, "tv_456_s1e2", 99);
  assert.deepEqual(us.getBootstrap(db, a).progress, { movie_550: 40, tv_456_s1e2: 99 });
  assert.deepEqual(us.getBootstrap(db, b).progress, {});
});

test("watched set/delete round-trips", () => {
  const { db, a } = makeDb();
  us.setWatched(db, a, "movie_550");
  us.setWatched(db, a, "movie_550"); // idempotent
  assert.deepEqual(us.getBootstrap(db, a).watched, { movie_550: true });
  us.deleteWatched(db, a, "movie_550");
  assert.deepEqual(us.getBootstrap(db, a).watched, {});
});

test("history dedupes by title, newest first, caps at 500, returns 50", () => {
  const { db, a } = makeDb();
  us.addHistory(db, a, { id: 1, media_type: "tv", title: "Show", poster_path: "/p.jpg", season: 1, episode: 1, episodeName: "Pilot", watchedAt: 1000 });
  us.addHistory(db, a, { id: 1, media_type: "tv", title: "Show", poster_path: "/p.jpg", season: 1, episode: 2, episodeName: "Two", watchedAt: 2000 });
  let h = us.getBootstrap(db, a).history;
  assert.equal(h.length, 1); // deduped by (media_type, tmdb_id)
  assert.equal(h[0].episode, 2);
  assert.equal(h[0].watchedAt, 2000);
  assert.equal(h[0].episodeName, "Two");

  for (let i = 0; i < 520; i++) {
    us.addHistory(db, a, { id: 10000 + i, media_type: "movie", title: `M${i}`, poster_path: null, season: null, episode: null, episodeName: null, watchedAt: 3000 + i });
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM history WHERE user_id = ?").get(a).n;
  assert.equal(count, 500);
  h = us.getBootstrap(db, a).history;
  assert.equal(h.length, 50);
  assert.equal(h[0].id, 10519); // newest first
});

test("clearHistory empties only that user's history", () => {
  const { db, a, b } = makeDb();
  us.addHistory(db, a, { id: 1, media_type: "movie", title: "A", poster_path: null, season: null, episode: null, episodeName: null, watchedAt: 1 });
  us.addHistory(db, b, { id: 2, media_type: "movie", title: "B", poster_path: null, season: null, episode: null, episodeName: null, watchedAt: 1 });
  us.clearHistory(db, a);
  assert.equal(us.getBootstrap(db, a).history.length, 0);
  assert.equal(us.getBootstrap(db, b).history.length, 1);
});

test("library add/remove/order", () => {
  const { db, a } = makeDb();
  const item1 = { id: 550, title: "Fight Club", poster_path: "/f.jpg", media_type: "movie", vote_average: 8.4, year: "1999" };
  const item2 = { id: 456, title: "The Show", poster_path: "/s.jpg", media_type: "tv", vote_average: 7.1, year: "2020" };
  us.upsertLibraryItem(db, a, "movie_550", item1);
  us.upsertLibraryItem(db, a, "tv_456", item2);
  let boot = us.getBootstrap(db, a);
  assert.deepEqual(boot.libraryOrder, ["movie_550", "tv_456"]);
  assert.equal(boot.library.movie_550.title, "Fight Club");
  assert.equal(boot.library.tv_456.year, "2020");

  us.setLibraryOrder(db, a, ["tv_456", "movie_550", "movie_999"]); // unknown key ignored
  boot = us.getBootstrap(db, a);
  assert.deepEqual(boot.libraryOrder, ["tv_456", "movie_550"]);

  us.deleteLibraryItem(db, a, "tv_456");
  boot = us.getBootstrap(db, a);
  assert.deepEqual(boot.libraryOrder, ["movie_550"]);
  assert.equal(boot.library.tv_456, undefined);
});

test("bad keys throw BADKEY", () => {
  const { db, a } = makeDb();
  assert.throws(() => us.upsertLibraryItem(db, a, "junk", { id: 1 }), (e) => e.code === "BADKEY");
  assert.throws(() => us.upsertLibraryItem(db, a, "movie_abc", { id: 1 }), (e) => e.code === "BADKEY");
});

test("settings bulk upsert stores arbitrary JSON values", () => {
  const { db, a } = makeDb();
  us.setSettings(db, a, { accentColor: "red", homeRowOrder: ["continue", "similar"], ageLimit: 16 });
  us.setSettings(db, a, { accentColor: "blue" });
  const s = us.getBootstrap(db, a).settings;
  assert.equal(s.accentColor, "blue");
  assert.deepEqual(s.homeRowOrder, ["continue", "similar"]);
  assert.equal(s.ageLimit, 16);
});

test("importState merges: progress LWW, watched union, history newer-wins, library appends", () => {
  const { db, a } = makeDb();
  // Pre-existing server state
  us.upsertProgress(db, a, "movie_1", 10);
  us.setWatched(db, a, "movie_1");
  us.addHistory(db, a, { id: 5, media_type: "movie", title: "Old", poster_path: null, season: null, episode: null, episodeName: null, watchedAt: 5000 });
  us.upsertLibraryItem(db, a, "movie_1", { id: 1, title: "One", poster_path: null, media_type: "movie", vote_average: 5, year: "2001" });

  const result = us.importState(db, a, {
    progress: { movie_1: 55, movie_2: 20 },          // LWW: overwrites movie_1
    watched: { movie_2: true },                        // union
    history: [
      { id: 5, media_type: "movie", title: "Old", poster_path: null, season: null, episode: null, episodeName: null, watchedAt: 4000 }, // older → ignored
      { id: 6, media_type: "movie", title: "New", poster_path: null, season: null, episode: null, episodeName: null, watchedAt: 9000 },
    ],
    saved: {
      movie_1: { id: 1, title: "One", poster_path: null, media_type: "movie", vote_average: 5, year: "2001" }, // exists → kept
      movie_7: { id: 7, title: "Seven", poster_path: null, media_type: "movie", vote_average: 6, year: "1995" },
    },
    savedOrder: ["movie_7", "movie_1"],
    settings: { accentColor: "red" },
  });

  assert.equal(result.progress.movie_1, 55);
  assert.equal(result.progress.movie_2, 20);
  assert.deepEqual(result.watched, { movie_1: true, movie_2: true });
  const hist = result.history;
  assert.equal(hist.find((h) => h.id === 5).watchedAt, 5000); // server newer kept
  assert.equal(hist.find((h) => h.id === 6).watchedAt, 9000);
  // movie_1 kept its position (1st), movie_7 appended after
  assert.deepEqual(result.libraryOrder, ["movie_1", "movie_7"]);
  assert.equal(result.settings.accentColor, "red");
});

test("importState on a fresh user follows savedOrder for positions", () => {
  const { db, a } = makeDb();
  const result = us.importState(db, a, {
    progress: {}, watched: {}, history: [],
    saved: {
      movie_1: { id: 1, title: "One", poster_path: null, media_type: "movie", vote_average: 5, year: "2001" },
      movie_2: { id: 2, title: "Two", poster_path: null, media_type: "movie", vote_average: 5, year: "2002" },
    },
    savedOrder: ["movie_2", "movie_1"],
    settings: {},
  });
  assert.deepEqual(result.libraryOrder, ["movie_2", "movie_1"]);
});

test("deleting a user cascades all state rows", () => {
  const { db, a } = makeDb();
  us.upsertProgress(db, a, "movie_550", 40);
  us.setWatched(db, a, "movie_550");
  us.addHistory(db, a, { id: 1, media_type: "movie", title: "A", poster_path: null, season: null, episode: null, episodeName: null, watchedAt: 1 });
  us.upsertLibraryItem(db, a, "movie_550", { id: 550, title: "F", poster_path: null, media_type: "movie", vote_average: 8, year: "1999" });
  us.setSettings(db, a, { accentColor: "red" });
  db.prepare("DELETE FROM users WHERE id = ?").run(a);
  for (const t of ["watch_progress", "watched_titles", "history", "library", "user_settings"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(a).n, 0, t);
  }
});
