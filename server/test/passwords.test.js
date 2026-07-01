"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { hashPassword, verifyPassword } = require("../lib/passwords");

test("verify succeeds for the correct password", () => {
  const { hash, salt } = hashPassword("hunter2!");
  assert.equal(verifyPassword("hunter2!", hash, salt), true);
});

test("verify fails for a wrong password", () => {
  const { hash, salt } = hashPassword("hunter2!");
  assert.equal(verifyPassword("nope", hash, salt), false);
});

test("same password hashes differently (random salt)", () => {
  const a = hashPassword("samepass");
  const b = hashPassword("samepass");
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.salt, b.salt);
});

test("verify returns false when hash/salt missing", () => {
  assert.equal(verifyPassword("x", "", ""), false);
});
