"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { openDb } = require("../lib/db");

test("openDb creates the users table", () => {
  const db = openDb(":memory:");
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  assert.equal(row && row.name, "users");
  db.close();
});

test("openDb reopening the same file is idempotent and preserves data", () => {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-db-"));
  const file = path.join(dir, "test.db");
  const db1 = openDb(file);
  db1
    .prepare("INSERT INTO users (username, pw_hash, pw_salt, role, created_at) VALUES (?,?,?,?,?)")
    .run("alice", "h", "s", "user", Date.now());
  db1.close();
  // Re-open the SAME file: migrate() must be idempotent (CREATE TABLE IF NOT
  // EXISTS) and the previously-inserted row must survive.
  const db2 = openDb(file);
  const row = db2.prepare("SELECT username FROM users WHERE username = 'alice'").get();
  assert.equal(row && row.username, "alice");
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("users.status column exists and defaults to active", () => {
  const { insertUser } = require("../lib/users");
  const db = openDb(":memory:");
  insertUser(db, { username: "u1@example.com", password: "password1" });
  const row = db.prepare("SELECT status FROM users WHERE username = 'u1@example.com' COLLATE NOCASE").get();
  assert.equal(row.status, "active");
  // idempotent: migrate again (re-open same handle path is n/a for :memory:, so
  // just assert the PRAGMA shows exactly one status column)
  const cols = db.prepare("PRAGMA table_info(users)").all().filter((c) => c.name === "status");
  assert.equal(cols.length, 1);
});
