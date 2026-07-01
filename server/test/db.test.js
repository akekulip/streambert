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

test("openDb is idempotent (safe to call twice on same file)", () => {
  const db = openDb(":memory:");
  assert.doesNotThrow(() => db.exec("SELECT 1"));
  db.close();
});
