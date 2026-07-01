"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { buildEmbedUrl, parseRcpUrl } = require("../extract");
const { handleExtract } = require("../server");

test("buildEmbedUrl builds movie and tv urls", () => {
  assert.equal(buildEmbedUrl({ tmdb: "550", type: "movie" }), "https://vidsrc.me/embed/movie/550");
  assert.equal(buildEmbedUrl({ tmdb: "1396", type: "tv", season: 1, episode: 1 }), "https://vidsrc.me/embed/tv/1396/1/1");
});

test("parseRcpUrl extracts the rcp iframe url", () => {
  const html = `<div><iframe id="player_iframe" src="//cloudx.example.com/rcp/ABC123=="></iframe></div>`;
  assert.equal(parseRcpUrl(html), "https://cloudx.example.com/rcp/ABC123==");
  assert.equal(parseRcpUrl("<div>no player here</div>"), null);
});

test("handleExtract validates input", async () => {
  const okStream = async () => ({ m3u8: "https://cdn/master.m3u8?token=x", referer: "https://cdn/" });
  assert.equal((await handleExtract({}, { extractStream: okStream })).status, 400);
  assert.equal((await handleExtract({ tmdb: "1", type: "bad" }, { extractStream: okStream })).status, 400);
  assert.equal((await handleExtract({ tmdb: "1", type: "tv" }, { extractStream: okStream })).status, 400);
  const ok = await handleExtract({ tmdb: "550", type: "movie" }, { extractStream: okStream });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.m3u8, "https://cdn/master.m3u8?token=x");
});

test("handleExtract maps extractor errors to status codes", async () => {
  const { NoStreamError, TimeoutError } = require("../extract");
  const noStream = async () => { throw new NoStreamError("no m3u8"); };
  const timeout = async () => { throw new TimeoutError("slow"); };
  assert.equal((await handleExtract({ tmdb: "1", type: "movie" }, { extractStream: noStream })).status, 404);
  assert.equal((await handleExtract({ tmdb: "1", type: "movie" }, { extractStream: timeout })).status, 504);
});
