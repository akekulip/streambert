"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { openDb } = require("../lib/db");
const U = require("../lib/users");

function db() { return openDb(":memory:"); }

test("createUser + getUserByUsername round-trips (case-insensitive)", () => {
  const d = db();
  const u = U.createUser(d, { username: "Alice", password: "password1", role: "user" });
  assert.equal(u.username, "Alice");
  assert.equal(U.getUserByUsername(d, "alice").id, u.id);
});

test("createUser rejects short passwords and duplicates", () => {
  const d = db();
  assert.throws(() => U.createUser(d, { username: "bob", password: "short" }));
  U.createUser(d, { username: "bob", password: "password1" });
  assert.throws(() => U.createUser(d, { username: "BOB", password: "password1" }), (e) => e.code === "DUP");
});

test("resetPassword changes the stored hash", () => {
  const d = db();
  const u = U.createUser(d, { username: "carol", password: "password1" });
  U.resetPassword(d, u.id, "password2");
  const row = U.getUserById(d, u.id);
  assert.equal(U.verifyPassword("password2", row.pw_hash, row.pw_salt), true);
  assert.equal(U.verifyPassword("password1", row.pw_hash, row.pw_salt), false);
});

test("deleteUser refuses to remove the last admin", () => {
  const d = db();
  const a = U.createUser(d, { username: "admin", password: "password1", role: "admin" });
  assert.throws(() => U.deleteUser(d, a.id), (e) => e.code === "LAST_ADMIN");
  U.createUser(d, { username: "admin2", password: "password1", role: "admin" });
  assert.doesNotThrow(() => U.deleteUser(d, a.id));
});

test("bootstrapAdmin creates an admin only when users table is empty", () => {
  const d = db();
  const first = U.bootstrapAdmin(d, { adminUser: "root", adminPassword: "short" });
  assert.equal(first.role, "admin");
  assert.equal(first.username, "root");
  const second = U.bootstrapAdmin(d, { adminUser: "root2", adminPassword: "whatever8" });
  assert.equal(second, null);
  assert.equal(U.listUsers(d).length, 1);
});
