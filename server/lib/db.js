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
