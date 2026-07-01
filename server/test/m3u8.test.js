"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { rewriteM3u8 } = require("../lib/m3u8");

test("rewriteM3u8 routes nested URIs back through /api/proxy with referer", () => {
  const base = "https://cdn.example.com/pl/GZIP/master.m3u8?token=T";
  const ref = "https://cdn.example.com/";
  const body = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1",
    "/pl/GZIP/HASH/index.m3u8?token=T2",
    "#EXT-X-STREAM-INF:BANDWIDTH=2",
    "sub/index.m3u8",
  ].join("\n");
  const out = rewriteM3u8(body, base, ref).split("\n");
  assert.equal(out[0], "#EXTM3U");
  assert.equal(
    out[2],
    `/api/proxy?url=${encodeURIComponent("https://cdn.example.com/pl/GZIP/HASH/index.m3u8?token=T2")}&referer=${encodeURIComponent(ref)}`,
  );
  assert.equal(
    out[4],
    `/api/proxy?url=${encodeURIComponent("https://cdn.example.com/pl/GZIP/sub/index.m3u8")}&referer=${encodeURIComponent(ref)}`,
  );
});

test("rewriteM3u8 rewrites URI= attributes through the proxy and leaves tags", () => {
  const base = "https://cdn.example.com/v/index.m3u8";
  const ref = "https://cdn.example.com/";
  const body = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nseg0.ts';
  const out = rewriteM3u8(body, base, ref);
  assert.match(out, /URI="\/api\/proxy\?url=/);
  assert.ok(out.includes(encodeURIComponent("https://cdn.example.com/v/key.bin")));
  assert.ok(out.includes(encodeURIComponent("https://cdn.example.com/v/seg0.ts")));
  assert.match(out, /#EXTINF:6,/);
});

test("rewriteM3u8 omits the referer param when none is given", () => {
  const out = rewriteM3u8("seg0.ts", "https://cdn.example.com/v/index.m3u8");
  assert.equal(
    out,
    `/api/proxy?url=${encodeURIComponent("https://cdn.example.com/v/seg0.ts")}`,
  );
});
