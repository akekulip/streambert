import { test } from "node:test";
import assert from "node:assert";
import { toPct, shouldSave, isWatched } from "./progress.mjs";

test("toPct floors and caps at 100", () => {
  assert.equal(toPct(30, 120), 25);
  assert.equal(toPct(200, 120), 100); // 166 uncapped -> exercises the Math.min cap
  assert.equal(toPct(10, 0), 0);
});
test("shouldSave respects interval and first-save", () => {
  assert.equal(shouldSave(null, 1000), true);
  assert.equal(shouldSave(1000, 5999), false);
  assert.equal(shouldSave(1000, 6000), true);
});
test("isWatched when remaining within threshold seconds", () => {
  assert.equal(isWatched(100, 120, 20), true);   // 20s left
  assert.equal(isWatched(99, 120, 20), false);    // 21s left
  assert.equal(isWatched(120, 120, 20), true);    // 0s left
  assert.equal(isWatched(10, 0, 20), false);      // no duration
});
