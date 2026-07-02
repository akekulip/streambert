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
