"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { rewriteM3u8 } = require("../lib/m3u8");

test("rewriteM3u8 makes nested URIs absolute against the master URL", () => {
  const base = "https://cdn.example.com/pl/GZIP/master.m3u8?token=T";
  const body = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1",
    "/pl/GZIP/HASH/index.m3u8?token=T2",
    "#EXT-X-STREAM-INF:BANDWIDTH=2",
    "sub/index.m3u8",
  ].join("\n");
  const out = rewriteM3u8(body, base).split("\n");
  assert.equal(out[2], "https://cdn.example.com/pl/GZIP/HASH/index.m3u8?token=T2");
  assert.equal(out[4], "https://cdn.example.com/pl/GZIP/sub/index.m3u8");
  assert.equal(out[0], "#EXTM3U");
});

test("rewriteM3u8 rewrites URI= attributes and leaves other tags", () => {
  const base = "https://cdn.example.com/v/index.m3u8";
  const body = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nseg0.ts';
  const out = rewriteM3u8(body, base);
  assert.match(out, /URI="https:\/\/cdn\.example\.com\/v\/key\.bin"/);
  assert.match(out, /https:\/\/cdn\.example\.com\/v\/seg0\.ts/);
  assert.match(out, /#EXTINF:6,/);
});
