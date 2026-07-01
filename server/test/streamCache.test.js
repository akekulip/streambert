"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createCache } = require("../lib/streamCache");

test("cache stores and returns values", () => {
  const c = createCache({ ttlMs: 1000, max: 10 });
  c.set("k", { url: "u" });
  assert.deepEqual(c.get("k"), { url: "u" });
  assert.equal(c.get("missing"), null);
});

test("cache expires entries past ttl", async () => {
  const c = createCache({ ttlMs: 10, max: 10 });
  c.set("k", 1);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.get("k"), null);
});

test("cache evicts oldest past max", () => {
  const c = createCache({ ttlMs: 10000, max: 2 });
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  assert.equal(c.get("a"), null);
  assert.equal(c.get("c"), 3);
  assert.equal(c._size(), 2);
});
