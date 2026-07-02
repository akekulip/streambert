"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isValidIdentifier, isValidPassword } = require("../lib/users");

test("isValidIdentifier accepts emails and phones, rejects junk", () => {
  assert.equal(isValidIdentifier("a@b.co"), true);
  assert.equal(isValidIdentifier("+1 234-567-8901"), true);
  assert.equal(isValidIdentifier("5551234567"), true);
  assert.equal(isValidIdentifier("notanemail"), false);
  assert.equal(isValidIdentifier("12345"), false); // too short for a phone
  assert.equal(isValidIdentifier(""), false);
});
test("isValidPassword requires >= 8 chars", () => {
  assert.equal(isValidPassword("password1"), true);
  assert.equal(isValidPassword("short"), false);
  assert.equal(isValidPassword(""), false);
});

const { openDb } = require("../lib/db");
const { registerUser, setUserStatus, listUsers, getUserByUsername } = require("../lib/users");

test("registerUser creates a pending user", () => {
  const db = openDb(":memory:");
  const u = registerUser(db, { identifier: "new@user.com", password: "password1" });
  assert.equal(u.status, "pending");
  assert.equal(getUserByUsername(db, "new@user.com").status, "pending");
});
test("registerUser rejects bad input and duplicates", () => {
  const db = openDb(":memory:");
  assert.throws(() => registerUser(db, { identifier: "bad", password: "password1" }), /BADINPUT|invalid/i);
  assert.throws(() => registerUser(db, { identifier: "a@b.co", password: "short" }), /BADINPUT|invalid/i);
  registerUser(db, { identifier: "a@b.co", password: "password1" });
  assert.throws(() => registerUser(db, { identifier: "A@B.CO", password: "password1" }), (e) => e.code === "DUP");
});
test("setUserStatus flips status; listUsers exposes it", () => {
  const db = openDb(":memory:");
  const u = registerUser(db, { identifier: "c@d.com", password: "password1" });
  setUserStatus(db, u.id, "active");
  assert.equal(getUserByUsername(db, "c@d.com").status, "active");
  assert.ok(listUsers(db).every((r) => "status" in r));
});
