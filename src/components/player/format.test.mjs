import { test } from "node:test";
import assert from "node:assert";
import { formatTime } from "./format.mjs";

test("formats under an hour as m:ss", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(9), "0:09");
  assert.equal(formatTime(754), "12:34");
});
test("formats over an hour as h:mm:ss", () => {
  assert.equal(formatTime(3661), "1:01:01");
});
test("clamps NaN/negative to 0:00", () => {
  assert.equal(formatTime(NaN), "0:00");
  assert.equal(formatTime(-5), "0:00");
});
