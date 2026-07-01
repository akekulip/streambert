# Per-User Server State (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move watch progress, watched marks, history, library, and user settings from browser localStorage into SQLite keyed by `user_id`, with cross-device sync, one-time migration, and live multi-device updates.

**Architecture:** Normalized SQLite tables for the four content domains + a KV table for settings (spec: `docs/superpowers/specs/2026-07-01-per-user-server-state-design.md`). New `/api/state` Fastify route module backed by a pure `server/lib/userState.js`. Client-side `src/utils/userState.js` mirrors writes to localStorage (instant paint + offline fallback) and syncs to the server; App.jsx handlers swap their `storage.set` lines for userState calls.

**Tech Stack:** Fastify 4 + better-sqlite3 (CommonJS, `"use strict"`), React 18 + Vite (ESM), `node:test` for server tests. No new npm dependencies.

## Global Constraints

- **Node 20 required for all commands** — the sandbox default node is v10. Prefix every test/build command with: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`
- Server tests: `node --test server/test/` (or a single file). Frontend check: `npm run build`.
- Server code: CommonJS, `"use strict";` first line, 2-space indent, double quotes (match existing `server/lib/*.js`).
- Frontend code: ESM, match existing style in `src/utils/*.js`.
- History cap: **500 rows/user** server-side; bootstrap returns newest **50**.
- Write rate limit: **120 writes/min/user** on `/api/state` mutations.
- Client progress throttle: **one send per 10 s** (batched per key), flushed on pagehide via `sendBeacon`.
- Conventional Commits. Commit after each green task.
- All `/api/state` routes are session-gated automatically by the existing `preHandler` in `server/app.js` (they are not in `OPEN`); every DB query MUST be scoped by `req.user.id`.
- Media key formats (existing, do not change): progress/watched keys `movie_<tmdbId>` or `tv_<tmdbId>_s<season>e<episode>`; library/history title keys `movie_<tmdbId>` or `tv_<tmdbId>`.

---

### Task 1: Schema + `server/lib/userState.js` (pure DB accessors + merge logic)

**Files:**
- Modify: `server/lib/db.js` (add 5 tables to `migrate()`)
- Create: `server/lib/userState.js`
- Test: `server/test/userState.test.js`

**Interfaces:**
- Consumes: `openDb(path)` from `server/lib/db.js`; `insertUser(db, {...})` from `server/lib/users.js`.
- Produces (all take `db` first, then `userId`):
  - `getBootstrap(db, userId)` → `{ progress: {key:pct}, watched: {key:true}, history: [entry...newest-first, ≤50], library: {key:item}, libraryOrder: [key]|null, settings: {key:value} }`
  - `upsertProgress(db, userId, mediaKey, pct)`
  - `setWatched(db, userId, mediaKey)` / `deleteWatched(db, userId, mediaKey)`
  - `addHistory(db, userId, entry)` — entry `{id, media_type, title, poster_path, season, episode, episodeName, watchedAt}`
  - `clearHistory(db, userId)`
  - `upsertLibraryItem(db, userId, key, item)` — item `{id, title, poster_path, media_type, vote_average, year}`
  - `deleteLibraryItem(db, userId, key)`
  - `setLibraryOrder(db, userId, keys)`
  - `setSettings(db, userId, obj)`
  - `importState(db, userId, payload)` → returns `getBootstrap(...)`; payload `{progress, watched, history, saved, savedOrder, settings}` (localStorage shapes)
  - Bad library/history key → throws `Error` with `.code = "BADKEY"`.
  - History entry client shape (returned by bootstrap): `{id, title, poster_path, media_type, watchedAt, season, episode, episodeName}`.

- [ ] **Step 1: Write the failing test**

Create `server/test/userState.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/userState.test.js`
Expected: FAIL with `Cannot find module '../lib/userState'`

- [ ] **Step 3: Add the schema to `server/lib/db.js`**

In `migrate(db)`, extend the existing `db.exec` template string — after the `users` table definition, add:

```sql
    CREATE TABLE IF NOT EXISTS watch_progress (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_key  TEXT    NOT NULL,
      pct        REAL    NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, media_key)
    );
    CREATE TABLE IF NOT EXISTS watched_titles (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_key  TEXT    NOT NULL,
      marked_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, media_key)
    );
    CREATE TABLE IF NOT EXISTS history (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_type   TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
      tmdb_id      INTEGER NOT NULL,
      title        TEXT,
      poster_path  TEXT,
      season       INTEGER,
      episode      INTEGER,
      episode_name TEXT,
      watched_at   INTEGER NOT NULL,
      PRIMARY KEY (user_id, media_type, tmdb_id)
    );
    CREATE TABLE IF NOT EXISTS library (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_type   TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
      tmdb_id      INTEGER NOT NULL,
      title        TEXT,
      poster_path  TEXT,
      vote_average REAL,
      year         TEXT,
      position     INTEGER NOT NULL,
      added_at     INTEGER NOT NULL,
      PRIMARY KEY (user_id, media_type, tmdb_id)
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key        TEXT    NOT NULL,
      value_json TEXT    NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
```

- [ ] **Step 4: Write `server/lib/userState.js`**

```js
"use strict";
// Per-user state accessors (Phase 2). Pure functions over better-sqlite3;
// no fastify coupling so merge rules are unit-testable.

const HISTORY_CAP = 500;
const HISTORY_PAGE = 50;

// "movie_550" | "tv_456" → { media_type, tmdb_id }. History/library keys only —
// progress/watched media_key values are opaque strings.
function parseTitleKey(key) {
  const i = String(key).indexOf("_");
  const media_type = i > 0 ? key.slice(0, i) : "";
  const tmdb_id = Number(key.slice(i + 1));
  if ((media_type !== "movie" && media_type !== "tv") || !Number.isInteger(tmdb_id)) {
    const err = new Error(`bad key: ${key}`);
    err.code = "BADKEY";
    throw err;
  }
  return { media_type, tmdb_id };
}

function getBootstrap(db, userId) {
  const progress = {};
  for (const r of db.prepare("SELECT media_key, pct FROM watch_progress WHERE user_id = ?").all(userId)) {
    progress[r.media_key] = r.pct;
  }
  const watched = {};
  for (const r of db.prepare("SELECT media_key FROM watched_titles WHERE user_id = ?").all(userId)) {
    watched[r.media_key] = true;
  }
  const history = db
    .prepare("SELECT * FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT ?")
    .all(userId, HISTORY_PAGE)
    .map((r) => ({
      id: r.tmdb_id,
      title: r.title,
      poster_path: r.poster_path,
      media_type: r.media_type,
      watchedAt: r.watched_at,
      season: r.season,
      episode: r.episode,
      episodeName: r.episode_name,
    }));
  const library = {};
  const libraryOrder = [];
  for (const r of db.prepare("SELECT * FROM library WHERE user_id = ? ORDER BY position").all(userId)) {
    const key = `${r.media_type}_${r.tmdb_id}`;
    library[key] = {
      id: r.tmdb_id,
      title: r.title,
      poster_path: r.poster_path,
      media_type: r.media_type,
      vote_average: r.vote_average,
      year: r.year,
    };
    libraryOrder.push(key);
  }
  const settings = {};
  for (const r of db.prepare("SELECT key, value_json FROM user_settings WHERE user_id = ?").all(userId)) {
    try { settings[r.key] = JSON.parse(r.value_json); } catch { /* skip corrupt row */ }
  }
  return { progress, watched, history, library, libraryOrder: libraryOrder.length ? libraryOrder : null, settings };
}

function upsertProgress(db, userId, mediaKey, pct) {
  db.prepare(
    `INSERT INTO watch_progress (user_id, media_key, pct, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (user_id, media_key) DO UPDATE SET pct = excluded.pct, updated_at = excluded.updated_at`,
  ).run(userId, String(mediaKey), pct, Date.now());
}

function setWatched(db, userId, mediaKey) {
  db.prepare("INSERT OR IGNORE INTO watched_titles (user_id, media_key, marked_at) VALUES (?,?,?)")
    .run(userId, String(mediaKey), Date.now());
}

function deleteWatched(db, userId, mediaKey) {
  db.prepare("DELETE FROM watched_titles WHERE user_id = ? AND media_key = ?").run(userId, String(mediaKey));
}

function addHistory(db, userId, entry) {
  const tmdb_id = Number(entry.id);
  const media_type = entry.media_type === "tv" ? "tv" : "movie";
  if (!Number.isInteger(tmdb_id)) {
    const err = new Error("bad history id");
    err.code = "BADKEY";
    throw err;
  }
  db.prepare(
    `INSERT INTO history (user_id, media_type, tmdb_id, title, poster_path, season, episode, episode_name, watched_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (user_id, media_type, tmdb_id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       season = excluded.season, episode = excluded.episode,
       episode_name = excluded.episode_name, watched_at = excluded.watched_at`,
  ).run(
    userId, media_type, tmdb_id,
    entry.title ?? null, entry.poster_path ?? null,
    entry.season ?? null, entry.episode ?? null, entry.episodeName ?? null,
    Number(entry.watchedAt) || Date.now(),
  );
  db.prepare(
    `DELETE FROM history WHERE rowid IN (
       SELECT rowid FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT -1 OFFSET ?
     )`,
  ).run(userId, HISTORY_CAP);
}

function clearHistory(db, userId) {
  db.prepare("DELETE FROM history WHERE user_id = ?").run(userId);
}

function nextLibraryPosition(db, userId) {
  const r = db.prepare("SELECT MAX(position) AS m FROM library WHERE user_id = ?").get(userId);
  return (r.m ?? -1) + 1;
}

function upsertLibraryItem(db, userId, key, item) {
  const { media_type, tmdb_id } = parseTitleKey(key);
  const existing = db
    .prepare("SELECT position FROM library WHERE user_id = ? AND media_type = ? AND tmdb_id = ?")
    .get(userId, media_type, tmdb_id);
  const position = existing ? existing.position : nextLibraryPosition(db, userId);
  db.prepare(
    `INSERT INTO library (user_id, media_type, tmdb_id, title, poster_path, vote_average, year, position, added_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (user_id, media_type, tmdb_id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       vote_average = excluded.vote_average, year = excluded.year`,
  ).run(
    userId, media_type, tmdb_id,
    (item && item.title) ?? null, (item && item.poster_path) ?? null,
    (item && item.vote_average) ?? null, (item && item.year) ?? null,
    position, Date.now(),
  );
}

function deleteLibraryItem(db, userId, key) {
  const { media_type, tmdb_id } = parseTitleKey(key);
  db.prepare("DELETE FROM library WHERE user_id = ? AND media_type = ? AND tmdb_id = ?")
    .run(userId, media_type, tmdb_id);
}

const setLibraryOrderTx = (db) =>
  db.transaction((userId, keys) => {
    const upd = db.prepare("UPDATE library SET position = ? WHERE user_id = ? AND media_type = ? AND tmdb_id = ?");
    keys.forEach((key, i) => {
      let parsed;
      try { parsed = parseTitleKey(key); } catch { return; } // unknown/bad keys ignored
      upd.run(i, userId, parsed.media_type, parsed.tmdb_id);
    });
  });

function setLibraryOrder(db, userId, keys) {
  setLibraryOrderTx(db)(userId, Array.isArray(keys) ? keys : []);
}

function setSettings(db, userId, obj) {
  const upsert = db.prepare(
    `INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(obj || {})) upsert.run(userId, k, JSON.stringify(v), Date.now());
  });
  tx();
}

// Merge rules (spec §API): progress/settings LWW (imported overwrites),
// watched/library union (never deletes server rows; new library keys appended
// in savedOrder order), history dedupe-by-title keeping the newer watchedAt.
function importState(db, userId, payload) {
  const p = payload || {};
  const tx = db.transaction(() => {
    for (const [key, pct] of Object.entries(p.progress || {})) {
      if (Number.isFinite(Number(pct))) upsertProgress(db, userId, key, Number(pct));
    }
    for (const key of Object.keys(p.watched || {})) setWatched(db, userId, key);
    for (const entry of Array.isArray(p.history) ? p.history : []) {
      const existing = db
        .prepare("SELECT watched_at FROM history WHERE user_id = ? AND media_type = ? AND tmdb_id = ?")
        .get(userId, entry.media_type === "tv" ? "tv" : "movie", Number(entry.id));
      if (!existing || Number(entry.watchedAt) > existing.watched_at) {
        try { addHistory(db, userId, entry); } catch { /* skip bad entries */ }
      }
    }
    const saved = p.saved || {};
    const orderedKeys = Array.isArray(p.savedOrder)
      ? [...p.savedOrder, ...Object.keys(saved).filter((k) => !p.savedOrder.includes(k))]
      : Object.keys(saved);
    for (const key of orderedKeys) {
      if (!saved[key]) continue;
      const exists = (() => {
        try {
          const { media_type, tmdb_id } = parseTitleKey(key);
          return !!db.prepare("SELECT 1 FROM library WHERE user_id = ? AND media_type = ? AND tmdb_id = ?").get(userId, media_type, tmdb_id);
        } catch { return true; } // bad key → skip below
      })();
      if (!exists) {
        try { upsertLibraryItem(db, userId, key, saved[key]); } catch { /* skip bad keys */ }
      }
    }
    setSettings(db, userId, p.settings || {});
  });
  tx();
  return getBootstrap(db, userId);
}

module.exports = {
  getBootstrap, upsertProgress, setWatched, deleteWatched,
  addHistory, clearHistory, upsertLibraryItem, deleteLibraryItem,
  setLibraryOrder, setSettings, importState, parseTitleKey,
  HISTORY_CAP, HISTORY_PAGE,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/userState.test.js`
Expected: PASS (all tests)

- [ ] **Step 6: Run the full existing server suite (no regressions)**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/lib/db.js server/lib/userState.js server/test/userState.test.js
git commit -m "feat(server): per-user state schema + userState lib with import merge rules"
```

---

### Task 2: Per-user write limiter (`server/lib/writeLimiter.js`)

**Files:**
- Create: `server/lib/writeLimiter.js`
- Test: `server/test/writeLimiter.test.js`

**Interfaces:**
- Produces: `createWriteLimiter({ max = 120, windowMs = 60000, maxEntries = 10000 } = {})` → `{ allow(userId) => boolean }`. Fixed window per user; entry pruning bounds memory (same pattern as `server/lib/loginThrottle.js`).

- [ ] **Step 1: Write the failing test**

Create `server/test/writeLimiter.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createWriteLimiter } = require("../lib/writeLimiter");

test("allows up to max writes per window, then denies", () => {
  const lim = createWriteLimiter({ max: 3, windowMs: 60000 });
  assert.equal(lim.allow(1), true);
  assert.equal(lim.allow(1), true);
  assert.equal(lim.allow(1), true);
  assert.equal(lim.allow(1), false);
  assert.equal(lim.allow(2), true); // separate user unaffected
});

test("window resets after windowMs", async () => {
  const lim = createWriteLimiter({ max: 1, windowMs: 20 });
  assert.equal(lim.allow(1), true);
  assert.equal(lim.allow(1), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lim.allow(1), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/writeLimiter.test.js`
Expected: FAIL with `Cannot find module '../lib/writeLimiter'`

- [ ] **Step 3: Write `server/lib/writeLimiter.js`**

```js
"use strict";
// In-memory, single-process, fixed-window write limiter keyed by user id.
// Guards /api/state mutations against runaway clients (spec: ~120/min).
function createWriteLimiter({ max = 120, windowMs = 60 * 1000, maxEntries = 10000 } = {}) {
  const windows = new Map(); // userId -> { count, start }

  function allow(userId) {
    const now = Date.now();
    if (windows.size >= maxEntries) {
      for (const [k, w] of windows) {
        if (now - w.start > windowMs) windows.delete(k);
      }
    }
    let w = windows.get(userId);
    if (!w || now - w.start > windowMs) {
      w = { count: 0, start: now };
      windows.set(userId, w);
    }
    w.count += 1;
    return w.count <= max;
  }

  return { allow };
}

module.exports = { createWriteLimiter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/writeLimiter.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/writeLimiter.js server/test/writeLimiter.test.js
git commit -m "feat(server): per-user write limiter for state mutations"
```

---

### Task 3: User-scoped WS broadcast (`server/events.js` + `resolveUser` decorator)

**Files:**
- Modify: `server/app.js` (add `resolveUser` decorator next to `sessionValid`)
- Modify: `server/events.js` (clients Set → Map, add `broadcastToUser`)

**Interfaces:**
- Consumes: `resolveUser(fastify, req)` already defined in `server/app.js` (returns `{id, username, role}|null`).
- Produces: `fastify.resolveUser(req)` decorator; `fastify.broadcastToUser(userId, channel, payload)` — sends `{channel, payload}` JSON to every open WS whose session belongs to `userId`. Existing `fastify.broadcast(channel, payload)` behavior unchanged.

_No isolated unit test here — WS behavior is covered end-to-end by Task 5's integration test. This task must still leave the suite green._

- [ ] **Step 1: Add the decorator in `server/app.js`**

After the line `fastify.decorate("sessionValid", (req) => !!resolveUser(fastify, req));` add:

```js
  fastify.decorate("resolveUser", (req) => resolveUser(fastify, req));
```

- [ ] **Step 2: Rewrite `server/events.js`**

```js
"use strict";
// WebSocket event hub at /api/events. Broadcasts { channel, payload } frames.
// fastify.broadcast(...) sends to all authenticated clients;
// fastify.broadcastToUser(userId, ...) sends only to that user's sessions
// (cross-device state sync — Phase 2).

const clients = new Map(); // ws -> userId

module.exports = function (fastify) {
  fastify.decorate("broadcast", (channel, payload) => {
    const msg = JSON.stringify({ channel, payload });
    for (const ws of clients.keys()) {
      try {
        ws.send(msg);
      } catch {
        /* drop */
      }
    }
  });

  fastify.decorate("broadcastToUser", (userId, channel, payload) => {
    const msg = JSON.stringify({ channel, payload });
    for (const [ws, uid] of clients) {
      if (uid !== userId) continue;
      try {
        ws.send(msg);
      } catch {
        /* drop */
      }
    }
  });

  fastify.get("/api/events", { websocket: true }, (conn, req) => {
    // @fastify/websocket v10: conn.socket is the ws. Auth via session cookie.
    const user = fastify.resolveUser(req);
    if (!user) {
      try {
        conn.socket.close();
      } catch {}
      return;
    }
    clients.set(conn.socket, user.id);
    conn.socket.on("close", () => clients.delete(conn.socket));
    conn.socket.on("error", () => clients.delete(conn.socket));
  });
};
```

- [ ] **Step 3: Run the full server suite (no regressions)**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/app.js server/events.js
git commit -m "feat(server): user-scoped WS broadcast (broadcastToUser) + resolveUser decorator"
```

---

### Task 4: `/api/state` routes + `/api/me` returns `id`

**Files:**
- Create: `server/routes/state.js`
- Modify: `server/app.js` (register the module)
- Modify: `server/routes/auth.js:51` (add `id` to `/api/me`)
- Test: `server/test/state.test.js`

**Interfaces:**
- Consumes: everything from Task 1 (`server/lib/userState.js`), Task 2 (`createWriteLimiter`), Task 3 (`fastify.broadcastToUser`).
- Produces (all under prefix `/api/state`, session-gated):
  - `GET /bootstrap` → Task 1 bootstrap shape
  - `PUT /progress/:key` body `{pct: number}` → `{ok:true}`; 400 on non-finite pct
  - `POST /progress/beacon` body `{key, pct}` (accepts `text/plain` JSON for sendBeacon) → `{ok:true}`; no broadcast
  - `PUT /watched/:key` / `DELETE /watched/:key` → `{ok:true}`
  - `POST /history` body = history entry → `{ok:true}`
  - `DELETE /history` → `{ok:true}`
  - `PUT /library/:key` body = library item → `{ok:true}`; 400 on bad key
  - `DELETE /library/:key` → `{ok:true}`; 400 on bad key
  - `PUT /library/order` body `{keys: string[]}` → `{ok:true}`
  - `PUT /settings` body = `{key: value, ...}` → `{ok:true}`
  - `POST /import` body = `{progress, watched, history, saved, savedOrder, settings}` → fresh bootstrap payload
  - Mutations broadcast `state-changed {domain}` to the user's sessions (domains: `progress|watched|history|library|settings|all`); beacon does not.
  - Non-GET requests over the per-user limit → 429 `{error:"too many writes"}`
- `GET /api/me` now returns `{id, username, role}`.

- [ ] **Step 1: Write the failing test**

Create `server/test/state.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/state.test.js`
Expected: FAIL — `/api/state/bootstrap` 404s (module not registered), `/api/me` id missing

- [ ] **Step 3: Write `server/routes/state.js`**

```js
"use strict";
// Per-user state sync (Phase 2). Registered at /api/state; the global
// preHandler in app.js guarantees req.user. Every query is user-scoped.
const us = require("../lib/userState");
const { createWriteLimiter } = require("../lib/writeLimiter");

module.exports = async function (fastify) {
  const limiter = createWriteLimiter();

  // navigator.sendBeacon posts text/plain — parse it as JSON. The parser is
  // scoped to this plugin's encapsulation context, so other routes are unaffected.
  fastify.addContentTypeParser("text/plain", { parseAs: "string" }, (req, body, done) => {
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (e) {
      e.statusCode = 400;
      done(e);
    }
  });

  fastify.addHook("preHandler", async (req, reply) => {
    if (req.method === "GET") return;
    if (!limiter.allow(req.user.id)) {
      return reply.code(429).send({ error: "too many writes" });
    }
  });

  const changed = (req, domain) =>
    fastify.broadcastToUser(req.user.id, "state-changed", { domain });
  const badKey = (reply, e) => {
    if (e && e.code === "BADKEY") return reply.code(400).send({ error: "bad key" });
    throw e;
  };

  fastify.get("/bootstrap", async (req) => us.getBootstrap(fastify.db, req.user.id));

  fastify.put("/progress/:key", async (req, reply) => {
    const pct = Number((req.body || {}).pct);
    if (!Number.isFinite(pct)) return reply.code(400).send({ error: "bad pct" });
    us.upsertProgress(fastify.db, req.user.id, req.params.key, pct);
    changed(req, "progress");
    return { ok: true };
  });

  // sendBeacon flush on tab close — fire-and-forget, no broadcast.
  fastify.post("/progress/beacon", async (req, reply) => {
    const { key, pct } = req.body || {};
    if (!key || !Number.isFinite(Number(pct))) return reply.code(400).send({ error: "bad beacon" });
    us.upsertProgress(fastify.db, req.user.id, String(key), Number(pct));
    return { ok: true };
  });

  fastify.put("/watched/:key", async (req) => {
    us.setWatched(fastify.db, req.user.id, req.params.key);
    changed(req, "watched");
    return { ok: true };
  });

  fastify.delete("/watched/:key", async (req) => {
    us.deleteWatched(fastify.db, req.user.id, req.params.key);
    changed(req, "watched");
    return { ok: true };
  });

  fastify.post("/history", async (req, reply) => {
    try {
      us.addHistory(fastify.db, req.user.id, req.body || {});
    } catch (e) {
      return badKey(reply, e);
    }
    changed(req, "history");
    return { ok: true };
  });

  fastify.delete("/history", async (req) => {
    us.clearHistory(fastify.db, req.user.id);
    changed(req, "history");
    return { ok: true };
  });

  // Static "/library/order" outranks "/library/:key" in fastify's router,
  // so "order" is never captured as a media key.
  fastify.put("/library/order", async (req) => {
    us.setLibraryOrder(fastify.db, req.user.id, (req.body || {}).keys);
    changed(req, "library");
    return { ok: true };
  });

  fastify.put("/library/:key", async (req, reply) => {
    try {
      us.upsertLibraryItem(fastify.db, req.user.id, req.params.key, req.body || {});
    } catch (e) {
      return badKey(reply, e);
    }
    changed(req, "library");
    return { ok: true };
  });

  fastify.delete("/library/:key", async (req, reply) => {
    try {
      us.deleteLibraryItem(fastify.db, req.user.id, req.params.key);
    } catch (e) {
      return badKey(reply, e);
    }
    changed(req, "library");
    return { ok: true };
  });

  fastify.put("/settings", async (req) => {
    us.setSettings(fastify.db, req.user.id, req.body || {});
    changed(req, "settings");
    return { ok: true };
  });

  fastify.post("/import", async (req) => {
    const result = us.importState(fastify.db, req.user.id, req.body || {});
    changed(req, "all");
    return result;
  });
};
```

- [ ] **Step 4: Register in `server/app.js`**

In the `tryRegister` block, after the `./routes/secure` line, add:

```js
  await tryRegister("./routes/state", { prefix: "/api/state" });
```

- [ ] **Step 5: Add `id` to `/api/me` in `server/routes/auth.js`**

Change line 51 from:

```js
    return { username: req.user.username, role: req.user.role };
```

to:

```js
    return { id: req.user.id, username: req.user.username, role: req.user.role };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/state.test.js`
Expected: PASS

- [ ] **Step 7: Run the full server suite**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/routes/state.js server/app.js server/routes/auth.js server/test/state.test.js
git commit -m "feat(server): /api/state routes (bootstrap, writes, import) + id in /api/me"
```

---

### Task 5: WS live-sync integration test

**Files:**
- Test: `server/test/stateEvents.test.js`

**Interfaces:**
- Consumes: Tasks 3–4. Uses the `ws` package (present transitively via `@fastify/websocket`).
- Produces: proof that a state write by user A reaches A's other session and NOT user B.

- [ ] **Step 1: Write the test**

Create `server/test/stateEvents.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const WebSocket = require("ws");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function cookieFor(app, username, password) {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  return r.cookies.find((c) => c.name === "sb_session").value;
}

function connect(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, {
      headers: { cookie: `sb_session=${cookie}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

test("state-changed reaches the same user's sessions only", async () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  insertUser(db, { username: "bob", password: "bobpass12", role: "user" });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const alice = await cookieFor(app, "alice", "alicepass");
  const bob = await cookieFor(app, "bob", "bobpass12");

  const aliceWs = await connect(port, alice);
  const bobWs = await connect(port, bob);

  const aliceMsgs = [];
  const bobMsgs = [];
  aliceWs.on("message", (d) => aliceMsgs.push(JSON.parse(d.toString())));
  bobWs.on("message", (d) => bobMsgs.push(JSON.parse(d.toString())));

  await app.inject({
    method: "PUT", url: "/api/state/progress/movie_550",
    cookies: { sb_session: alice }, payload: { pct: 50 },
  });
  await new Promise((r) => setTimeout(r, 200));

  const stateMsgs = aliceMsgs.filter((m) => m.channel === "state-changed");
  assert.equal(stateMsgs.length, 1);
  assert.deepEqual(stateMsgs[0].payload, { domain: "progress" });
  assert.equal(bobMsgs.filter((m) => m.channel === "state-changed").length, 0);

  aliceWs.close();
  bobWs.close();
  await app.close();
});

test("unauthenticated WS is closed immediately", async () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const closed = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    ws.on("close", () => resolve(true));
    ws.on("error", () => resolve(true));
    setTimeout(() => resolve(false), 1000);
  });
  assert.equal(closed, true);
  await app.close();
});
```

- [ ] **Step 2: Run the test**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/stateEvents.test.js`
Expected: PASS (Tasks 3–4 already landed; if it fails, fix the events/routes code, not the test)

- [ ] **Step 3: Commit**

```bash
git add server/test/stateEvents.test.js
git commit -m "test(server): WS state-changed integration test (user-scoped delivery)"
```

---

### Task 6: Client sync module (`src/utils/userState.js`) + storage hook + shim event

**Files:**
- Modify: `src/utils/storage.js` (add a set-listener registration)
- Create: `src/utils/userState.js`
- Modify: `src/web/electron-shim.js` (expose `onStateChanged`/`offStateChanged`)
- Modify: `src/utils/backup.js` (mark state dirty after restore)

**Interfaces:**
- Consumes: `/api/state/*` from Task 4; `window.electron.onStateChanged` (added here); `storage`/`STORAGE_KEYS` from `src/utils/storage.js`.
- Produces (imported by App.jsx in Task 7 as `import * as userState from "./utils/userState"`):
  - `init(me, applyServerState)` — `me = {id, username, role}`; `applyServerState(data)` is called with every fresh server payload (bootstrap shape from Task 1)
  - `saveProgress(nextObj, key, pct)` · `flushProgress()`
  - `setWatchedState(nextObj, key, on)`
  - `addHistoryEntry(nextArr, entry)`
  - `saveLibraryItem(nextObj, key, item)` · `removeLibraryItem(nextObj, key)` · `saveLibraryOrder(nextArr)`
  - All write functions mirror to localStorage first, then sync; every one is a safe no-op before `init` succeeds (desktop build never calls `init`).
- `storage.js` gains `registerStorageSetListener(fn)`; `storage.set` invokes `fn(key, value)` after writing (key WITHOUT the `streambert_` prefix).

_No frontend test infra exists; verification is `npm run build` here and behavior tests via the server suite + the manual checklist in Task 8._

- [ ] **Step 1: Add the set-listener to `src/utils/storage.js`**

Above `export const storage = {`, add:

```js
// Optional post-write hook (registered by utils/userState.js on the web build)
// so user-level settings written anywhere (e.g. SettingsPage's 21 storage.set
// call sites) sync to the server without touching every call site.
let _onSet = null;
export const registerStorageSetListener = (fn) => {
  _onSet = fn;
};
```

In `storage.set`, after `localStorage.setItem(PREFIX + key, JSON.stringify(value));` (inside the same `try`), add:

```js
      if (_onSet) _onSet(key, value);
```

- [ ] **Step 2: Create `src/utils/userState.js`**

```js
// Server-backed per-user state sync (web build only — Phase 2).
// Mirrors every write to localStorage (instant paint + offline fallback) and
// syncs it to /api/state. Desktop builds never call init(), so all exports
// no-op there. Convergence guarantee: any failed write sets a dirty flag and
// the full local state is re-pushed through the idempotent POST /import.
import { storage, registerStorageSetListener } from "./storage";

const DIRTY_KEY = "dirtyState"; // stored as streambert_dirtyState
const PROGRESS_INTERVAL_MS = 10 * 1000;
const REFETCH_GUARD_MS = 5 * 1000;
const REFETCH_DEBOUNCE_MS = 1000;

// localStorage keys (unprefixed) that sync as user-level settings. Everything
// else — device prefs (fontSize, compactMode, reduceAnimations, dl*) and
// caches — stays local. See spec "Settings split".
const SYNCED_SETTINGS = new Set([
  "playerSource", "allmangaDubMode", "startPage", "ageLimit", "ratingCountry",
  "watchedThreshold", "autoplayNextEnabled", "autoplayNextDuration",
  "autoplayNextLayout", "homeRowOrder", "homeRowVisible", "homeViewMode",
  "subtitleDownload", "subtitleLang", "introSkipMode", "librarySort",
  "historyEnabled", "accentColor", "invidiousBase", "browseFilters",
]);

let _enabled = false;
let _initedFor = null;
let _applying = false;
let _apply = null;
let _lastWriteAt = 0;
let _refetchTimer = null;

const _pendingProgress = new Map(); // key -> pct
let _progressTimer = null;
let _lastProgressSend = 0;

const _pendingSettings = {};
let _settingsTimer = null;

function markDirty() {
  storage.set(DIRTY_KEY, 1);
}

async function api(method, path, body) {
  const res = await fetch(`/api/state${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res;
}

// Fire-and-forget write; failures set the dirty flag for later reconcile.
function send(method, path, body) {
  if (!_enabled) return;
  _lastWriteAt = Date.now();
  api(method, path, body).catch(() => markDirty());
}

function collectLocalState() {
  const settings = {};
  for (const k of SYNCED_SETTINGS) {
    const v = storage.get(k);
    if (v !== null) settings[k] = v;
  }
  return {
    progress: storage.get("progress") || {},
    watched: storage.get("watched") || {},
    history: storage.get("history") || [],
    saved: storage.get("saved") || {},
    savedOrder: storage.get("savedOrder"),
    settings,
  };
}

function hasLocalContent(s) {
  return (
    Object.keys(s.progress).length > 0 || Object.keys(s.watched).length > 0 ||
    s.history.length > 0 || Object.keys(s.saved).length > 0
  );
}

function serverIsEmpty(boot) {
  return (
    Object.keys(boot.progress).length === 0 && Object.keys(boot.watched).length === 0 &&
    boot.history.length === 0 && Object.keys(boot.library).length === 0
  );
}

function clearLocalState() {
  for (const k of ["progress", "watched", "history", "saved", "savedOrder", DIRTY_KEY]) {
    storage.remove(k);
  }
  for (const k of SYNCED_SETTINGS) storage.remove(k);
}

// Write server truth into the localStorage mirror + React state, suppressing
// the storage.set listener so settings don't echo back to the server.
function applyResult(data) {
  _applying = true;
  try {
    storage.set("progress", data.progress || {});
    storage.set("watched", data.watched || {});
    storage.set("history", data.history || []);
    storage.set("saved", data.library || {});
    if (data.libraryOrder) storage.set("savedOrder", data.libraryOrder);
    else storage.remove("savedOrder");
    for (const [k, v] of Object.entries(data.settings || {})) storage.set(k, v);
  } finally {
    _applying = false;
  }
  if (_apply) _apply(data);
}

// Bootstrap / migrate / reconcile. Safe to call repeatedly (focus, online,
// state-changed). Leaves _enabled false when the server is unreachable so
// writes stay local-only until the next attempt.
async function reconcile(userId) {
  try {
    const dirty = storage.get(DIRTY_KEY);
    if (_enabled && dirty) {
      const merged = await (await api("POST", "/import", collectLocalState())).json();
      storage.remove(DIRTY_KEY);
      applyResult(merged);
      return;
    }
    let boot = await (await api("GET", "/bootstrap")).json();
    const migratedFlag = `streambert_migrated_${userId}`;
    const local = collectLocalState();
    if (serverIsEmpty(boot) && hasLocalContent(local) && !localStorage.getItem(migratedFlag)) {
      boot = await (await api("POST", "/import", local)).json();
      localStorage.setItem(migratedFlag, "1");
    } else if (storage.get(DIRTY_KEY)) {
      boot = await (await api("POST", "/import", local)).json();
    }
    storage.remove(DIRTY_KEY);
    _enabled = true;
    applyResult(boot);
  } catch {
    /* offline / unauthenticated: stay on the localStorage cache */
  }
}

function onStorageSet(key, value) {
  if (!_enabled || _applying || !SYNCED_SETTINGS.has(key)) return;
  _pendingSettings[key] = value;
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(() => {
    const batch = { ..._pendingSettings };
    for (const k of Object.keys(_pendingSettings)) delete _pendingSettings[k];
    send("PUT", "/settings", batch);
  }, 500);
}

function onRemoteChange() {
  // Skip refetches triggered by our own just-sent writes.
  if (Date.now() - _lastWriteAt < REFETCH_GUARD_MS) return;
  clearTimeout(_refetchTimer);
  _refetchTimer = setTimeout(() => reconcile(_initedFor), REFETCH_DEBOUNCE_MS);
}

function sendPendingProgress() {
  _lastProgressSend = Date.now();
  for (const [key, pct] of _pendingProgress) {
    send("PUT", `/progress/${encodeURIComponent(key)}`, { pct });
  }
  _pendingProgress.clear();
}

export function flushProgress() {
  if (!_enabled || _pendingProgress.size === 0) return;
  for (const [key, pct] of _pendingProgress) {
    try {
      navigator.sendBeacon("/api/state/progress/beacon", JSON.stringify({ key, pct }));
    } catch {}
  }
  _pendingProgress.clear();
}

export async function init(me, applyServerState) {
  _apply = applyServerState;
  if (_initedFor === me.id) {
    reconcile(me.id);
    return;
  }
  // Shared-browser safety: a different user logged in — drop the previous
  // user's cached state BEFORE hydrating so it is never shown or imported.
  const last = localStorage.getItem("streambert_lastUserId");
  if (last && last !== String(me.id)) clearLocalState();
  localStorage.setItem("streambert_lastUserId", String(me.id));
  _initedFor = me.id;

  registerStorageSetListener(onStorageSet);
  window.addEventListener("focus", () => reconcile(me.id));
  window.addEventListener("online", () => reconcile(me.id));
  window.addEventListener("pagehide", flushProgress);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushProgress();
  });
  if (window.electron?.onStateChanged) window.electron.onStateChanged(onRemoteChange);

  await reconcile(me.id);
}

export function saveProgress(nextObj, key, pct) {
  storage.set("progress", nextObj);
  if (!_enabled) return;
  _pendingProgress.set(key, pct);
  const since = Date.now() - _lastProgressSend;
  if (since >= PROGRESS_INTERVAL_MS) {
    sendPendingProgress();
  } else if (!_progressTimer) {
    _progressTimer = setTimeout(() => {
      _progressTimer = null;
      sendPendingProgress();
    }, PROGRESS_INTERVAL_MS - since);
  }
}

export function setWatchedState(nextObj, key, on) {
  storage.set("watched", nextObj);
  send(on ? "PUT" : "DELETE", `/watched/${encodeURIComponent(key)}`);
}

export function addHistoryEntry(nextArr, entry) {
  storage.set("history", nextArr);
  send("POST", "/history", entry);
}

export function saveLibraryItem(nextObj, key, item) {
  storage.set("saved", nextObj);
  send("PUT", `/library/${encodeURIComponent(key)}`, item);
}

export function removeLibraryItem(nextObj, key) {
  storage.set("saved", nextObj);
  send("DELETE", `/library/${encodeURIComponent(key)}`);
}

export function saveLibraryOrder(nextArr) {
  storage.set("savedOrder", nextArr);
  send("PUT", "/library/order", { keys: nextArr });
}
```

- [ ] **Step 3: Expose the WS channel in `src/web/electron-shim.js`**

In the "Event subscriptions" block (after the `offDownloadProgress` line), add:

```js
    onStateChanged: (cb) => on("state-changed", cb),
    offStateChanged: (h) => off("state-changed", h),
```

- [ ] **Step 4: Mark state dirty after a backup restore in `src/utils/backup.js`**

In `restoreBackupData(data)`, after the loop that writes `localStorage.setItem(PREFIX + key, ...)`, add:

```js
  // Phase 2: restored localStorage must win over server state on next load —
  // the dirty flag routes it through POST /api/state/import's merge.
  try {
    localStorage.setItem("streambert_dirtyState", JSON.stringify(1));
  } catch {}
```

- [ ] **Step 5: Verify the frontend builds**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && npm run build`
Expected: build succeeds with no errors

- [ ] **Step 6: Commit**

```bash
git add src/utils/storage.js src/utils/userState.js src/web/electron-shim.js src/utils/backup.js
git commit -m "feat(web): client state-sync module (hydrate, migrate, throttled writes, live sync)"
```

---

### Task 7: Wire App.jsx to userState

**Files:**
- Modify: `src/App.jsx` (import, init effect, 7 handler swaps)

**Interfaces:**
- Consumes: every export of `src/utils/userState.js` (Task 6); existing `me` state (`{id, username, role}` after Task 4); existing setters `setProgress/setWatched/setHistory/setSaved/setSavedOrder/setLibrarySort`.
- Produces: the running app syncs all five domains. No prop or child-component changes.

- [ ] **Step 1: Add the import**

Next to the other `./utils` imports at the top of `src/App.jsx`:

```js
import * as userState from "./utils/userState";
```

- [ ] **Step 2: Add the hydration effect**

After the existing "Load the logged-in user" effect (the one calling `getMe()` around line 346–352), add:

```js
  // ── Per-user server state (web build): hydrate + keep in sync ─────────────
  const applyServerState = useCallback((data) => {
    setProgress(data.progress || {});
    setWatched(data.watched || {});
    setHistory(data.history || []);
    setSaved(data.library || {});
    setSavedOrder(data.libraryOrder || null);
    // Synced settings may have changed what's already on screen:
    setLibrarySort(storage.get(STORAGE_KEYS.LIBRARY_SORT) || "manual");
    applyAccentColor(storage.get(STORAGE_KEYS.ACCENT_COLOR) || "red");
  }, []);

  useEffect(() => {
    if (!window.__STREAMBERT_WEB__ || !me?.id) return;
    userState.init(me, applyServerState);
  }, [me, applyServerState]);
```

- [ ] **Step 3: Swap the handler writes**

Seven precise replacements (all inside existing handlers; leave everything else untouched):

1. In `toggleSave`, remove branch — replace `storage.set("savedOrder", newOrder);` with:
```js
          userState.saveLibraryOrder(newOrder);
```
2. In `toggleSave`, add branch — replace `storage.set("savedOrder", newOrder);` with:
```js
          userState.saveLibraryOrder(newOrder);
```
3. In `toggleSave`, after `setSaved(next);` — replace `storage.set("saved", next);` with:
```js
      if (isRemoving) userState.removeLibraryItem(next, id);
      else userState.saveLibraryItem(next, id, next[id]);
```
4. In `addHistory` — replace `storage.set("history", next);` with:
```js
      userState.addHistoryEntry(next, entry);
```
5. In `saveProgress` — replace `storage.set("progress", next);` with:
```js
      userState.saveProgress(next, key, pct);
```
6. In `markWatched` — replace `storage.set("watched", next);` with:
```js
      userState.setWatchedState(next, key, true);
```
   and in `markUnwatched` — replace `storage.set("watched", next);` with:
```js
      userState.setWatchedState(next, key, false);
```
7. In `handleReorderSaved` — replace `storage.set("savedOrder", newOrder);` with:
```js
    userState.saveLibraryOrder(newOrder);
```

(Each `userState` write mirrors to localStorage internally, so behavior on desktop — where `init` never runs — is byte-identical to the old `storage.set` calls.)

- [ ] **Step 4: Build**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && npm run build`
Expected: build succeeds

- [ ] **Step 5: Smoke-test against a local server**

```bash
export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH
rm -rf /tmp/sb-test
STREAMBERT_PASSWORD=testpass STREAMBERT_ADMIN_USER=admin \
  STREAMBERT_COOKIE_SECRET=0123456789abcdef0123456789abcdef \
  STREAMBERT_DATA=/tmp/sb-test node server/index.js &
sleep 2
# bootstrap admin "admin" is created from STREAMBERT_PASSWORD on first run (server/index.js:46-49)
curl -s -c /tmp/sb.jar -X POST http://localhost:8787/api/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"testpass"}'
curl -s -b /tmp/sb.jar http://localhost:8787/api/state/bootstrap
# expect: {"progress":{},"watched":{},"history":[],"library":{},"libraryOrder":null,"settings":{}}
curl -s -b /tmp/sb.jar -X PUT http://localhost:8787/api/state/progress/movie_550 \
  -H 'content-type: application/json' -d '{"pct":42}'
curl -s -b /tmp/sb.jar http://localhost:8787/api/state/bootstrap
# expect: progress {"movie_550":42}
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "feat(web): App.jsx hydrates from and writes through per-user server state"
```

---

### Task 8: Full verification + docs

**Files:**
- Modify: `docs/HANDOFF.md` (§4 add Phase 2 line; §6 note)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: green suite, green build, updated handoff.

- [ ] **Step 1: Full server suite**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && node --test server/test/`
Expected: PASS — including the pre-existing auth/admin/db/extract/m3u8/passwords/streamCache/throttle/users tests

- [ ] **Step 2: Frontend build**

Run: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && npm run build`
Expected: success

- [ ] **Step 3: Update `docs/HANDOFF.md`**

In §4, change the multi-user line to:

```markdown
- **Multi-user auth (Phase 1 + 2):** SQLite users, scrypt, signed-cookie sessions, admin Users panel. **Phase 2 (per-user server state) done:** watch progress/history/library/settings live in SQLite per user (`/api/state`, spec `docs/superpowers/specs/2026-07-01-per-user-server-state-design.md`) with localStorage as offline cache, one-time migration, and live cross-device sync over `/api/events`. Phase 3 (per-user downloads) NOT started.
```

- [ ] **Step 4: Manual two-user checklist (browser, against the local server from Task 7 Step 5)**

- [ ] Log in on two browsers (or normal + private window) as the same user; add a library item in one → appears in the other within ~2 s (WS) or on focus.
- [ ] Play something with VidSrc Direct/AllManga in one browser for >20 s; the other browser's Continue Watching shows the resume bar after refetch.
- [ ] Log in as a *different* user in one of the browsers → previous user's library/history is NOT visible.
- [ ] With localStorage state present and a fresh user's empty server state → data appears server-side after login (migration), verify via `curl .../api/state/bootstrap`.

- [ ] **Step 5: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: mark multi-user Phase 2 (per-user server state) done in handoff"
```

_Deploy to Vision is manual and out of plan scope — follow `docs/HANDOFF.md` §2 (app container only; schema migrates automatically on boot; daily DB backup already covers the new tables)._
