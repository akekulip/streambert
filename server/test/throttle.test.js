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

test("failure count resets after the window elapses", async () => {
  const t = createLoginThrottle({ max: 2, windowMs: 20, lockoutMs: 1000 });
  const k = "u|ip";
  t.registerFailure(k); // count = 1 within the window
  await new Promise((r) => setTimeout(r, 30)); // let the 20ms window elapse
  t.registerFailure(k); // window aged out -> count resets to 1, so not locked yet
  assert.equal(t.isLocked(k), false);
  t.registerFailure(k); // count reaches 2 -> now locked
  assert.equal(t.isLocked(k), true);
});
