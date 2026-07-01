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

test("withTimeout enforces a true end-to-end deadline without any network/browser", async () => {
  // Proves the timeout wrapper itself (used to bound queue-wait + embed
  // fetch + sniff as one deadline) rejects with TimeoutError promptly, and
  // that its onTimeout hook (used to close the browser context early on a
  // real timeout) fires — instead of waiting for the inner work to finish.
  const { withTimeout, TimeoutError } = require("../extract");
  const neverResolves = new Promise(() => {});
  let cleanedUp = false;
  const start = Date.now();
  await assert.rejects(
    () => withTimeout(50, neverResolves, () => { cleanedUp = true; }),
    TimeoutError,
  );
  assert.ok(Date.now() - start < 1000, "timeout should fire well within its budget, not wait on the never-resolving promise");
  assert.equal(cleanedUp, true, "onTimeout cleanup hook must run when the deadline fires");
});
