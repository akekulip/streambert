import { test } from "node:test";
import assert from "node:assert";
import { initialVideoState, reduceVideo } from "./videoState.mjs";

test("play/pause toggle playing", () => {
  const s = reduceVideo(initialVideoState, { type: "play" });
  assert.equal(s.playing, true);
  assert.equal(reduceVideo(s, { type: "pause" }).playing, false);
});
test("duration marks ready", () => {
  const s = reduceVideo(initialVideoState, { type: "duration", duration: 120 });
  assert.equal(s.duration, 120);
  assert.equal(s.ready, true);
});
test("time and buffered update fields", () => {
  let s = reduceVideo(initialVideoState, { type: "time", current: 12 });
  s = reduceVideo(s, { type: "buffered", bufferedEnd: 40 });
  assert.equal(s.current, 12);
  assert.equal(s.bufferedEnd, 40);
});
test("volume carries muted flag; ended stops playback", () => {
  let s = reduceVideo(initialVideoState, { type: "volume", volume: 0.3, muted: true });
  assert.deepEqual([s.volume, s.muted], [0.3, true]);
  s = reduceVideo({ ...s, playing: true }, { type: "ended" });
  assert.deepEqual([s.playing, s.ended], [false, true]);
});
test("unknown event returns same reference", () => {
  assert.equal(reduceVideo(initialVideoState, { type: "nope" }), initialVideoState);
});
