"use strict";
const Database = require("better-sqlite3");

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_hash    TEXT NOT NULL,
      pw_salt    TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      created_at INTEGER NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS watch_events (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_type TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
      tmdb_id    INTEGER NOT NULL,
      season     INTEGER,
      episode    INTEGER,
      watched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watch_events_time ON watch_events (watched_at);
    CREATE INDEX IF NOT EXISTS idx_watch_events_user ON watch_events (user_id, watched_at);
  `);

  // Registration/approval: add users.status if missing (existing rows -> active).
  // ALTER-added column omits CHECK (SQLite can't always add a CHECK column);
  // valid values ('pending'|'active'|'disabled') are enforced in lib/users.js.
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  if (!userCols.some((c) => c.name === "status")) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }

  // history is an upsert-per-title snapshot; watch_events (analytics) is the
  // append-only log. One-time seed so dashboards aren't empty on upgrade.
  const hasEvents = db.prepare("SELECT 1 FROM watch_events LIMIT 1").get();
  if (!hasEvents) {
    db.exec(`
      INSERT INTO watch_events (user_id, media_type, tmdb_id, season, episode, watched_at)
      SELECT user_id, media_type, tmdb_id, season, episode, watched_at FROM history
    `);
  }
}

function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

module.exports = { openDb };
