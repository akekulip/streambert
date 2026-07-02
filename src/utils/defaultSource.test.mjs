import { test } from "node:test";
import assert from "node:assert";
import { defaultNonAnimeSource } from "./defaultSource.mjs";

test("web build defaults to Videasy (preferred embed)", () => {
  assert.equal(defaultNonAnimeSource(true), "videasy");
});
test("desktop defaults to the plain vidsrc embed (no direct resolver there)", () => {
  assert.equal(defaultNonAnimeSource(false), "vidsrc");
});
