import { test } from "node:test";
import assert from "node:assert";
import { keyToAction } from "./keymap.mjs";

test("space and k toggle play", () => {
  assert.deepEqual(keyToAction(" ", {}), { type: "togglePlay" });
  assert.deepEqual(keyToAction("k", {}), { type: "togglePlay" });
});
test("arrows seek and change volume", () => {
  assert.deepEqual(keyToAction("ArrowLeft", {}), { type: "seekBy", delta: -10 });
  assert.deepEqual(keyToAction("ArrowRight", {}), { type: "seekBy", delta: 10 });
  assert.deepEqual(keyToAction("ArrowUp", {}), { type: "volumeBy", delta: 0.1 });
  assert.deepEqual(keyToAction("ArrowDown", {}), { type: "volumeBy", delta: -0.1 });
});
test("f/m/c map to fullscreen/mute/captions", () => {
  assert.deepEqual(keyToAction("f", {}), { type: "toggleFullscreen" });
  assert.deepEqual(keyToAction("m", {}), { type: "toggleMute" });
  assert.deepEqual(keyToAction("c", {}), { type: "toggleCaptions" });
});
test("no action while typing, or for unmapped keys", () => {
  assert.equal(keyToAction(" ", { typingInInput: true }), null);
  assert.equal(keyToAction("q", {}), null);
});
