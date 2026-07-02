import { test } from "node:test";
import assert from "node:assert";
import { defaultNonAnimeSource } from "./defaultSource.mjs";

test("web build defaults to server-extracted VidSrc Direct (ad-free for all)", () => {
  assert.equal(defaultNonAnimeSource(true), "vidsrc-direct");
});
test("desktop defaults to the plain vidsrc embed (no direct resolver there)", () => {
  assert.equal(defaultNonAnimeSource(false), "vidsrc");
});
