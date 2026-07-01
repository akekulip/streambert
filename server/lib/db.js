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
  `);
}

function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

module.exports = { openDb };
