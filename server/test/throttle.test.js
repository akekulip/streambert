"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createLoginThrottle } = require("../lib/loginThrottle");

test("locks after max failures and unlocks on reset", () => {
  const t = createLoginThrottle({ max: 3, lockoutMs: 10000 });
  const k = "user|1.2.3.4";
  t.registerFailure(k);
  t.registerFailure(k);
  assert.equal(t.isLocked(k), false);
  t.registerFailure(k);
  assert.equal(t.isLocked(k), true);
  t.reset(k);
  assert.equal(t.isLocked(k), false);
});

test("lockout expires after lockoutMs", () => {
  const t = createLoginThrottle({ max: 1, lockoutMs: -1 });
  t.registerFailure("k");
  // lockoutMs negative => lockedUntil already in the past
  assert.equal(t.isLocked("k"), false);
});
