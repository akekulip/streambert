"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createWriteLimiter } = require("../lib/writeLimiter");

test("allows up to max writes per window, then denies", () => {
  const lim = createWriteLimiter({ max: 3, windowMs: 60000 });
  assert.equal(lim.allow(1), true);
  assert.equal(lim.allow(1), true);
  assert.equal(lim.allow(1), true);
  assert.equal(lim.allow(1), false);
  assert.equal(lim.allow(2), true); // separate user unaffected
});

test("window resets after windowMs", async () => {
  const lim = createWriteLimiter({ max: 1, windowMs: 20 });
  assert.equal(lim.allow(1), true);
  assert.equal(lim.allow(1), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lim.allow(1), true);
});
