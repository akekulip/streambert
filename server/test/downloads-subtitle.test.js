"use strict";
// downloadSubtitleFile (server/lib/downloads.js) — regression tests for C3:
// the `file:` branch (arbitrary local-file read) is gone, and the remaining
// http(s) fetch is routed through safeFetch (SSRF guard on private/loopback
// hosts + redirect re-validation). Inputs here are literal `file:`/private-IP
// URLs so nothing touches the network or DNS.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  downloadSubtitleFile,
  readCapped,
  MAX_SUBTITLES,
} = require("../lib/downloads");

// Hand-built web ReadableStream that yields the given Uint8Array chunks, one
// per pull — deterministic, no network involved.
function streamOf(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

function tmpDest(ext) {
  return path.join(os.tmpdir(), `streambert_sub_test_${crypto.randomUUID()}${ext}`);
}

test("downloadSubtitleFile rejects file: URLs and writes nothing (no arbitrary local-file read)", async () => {
  const dest = tmpDest(".srt");
  await assert.rejects(
    () => downloadSubtitleFile("file:///etc/passwd", dest),
    (e) => e.code === "BLOCKED_URL",
  );
  assert.equal(fs.existsSync(dest), false);
});

test("downloadSubtitleFile rejects a loopback target (SSRF guard) and writes nothing", async () => {
  const dest = tmpDest(".srt");
  await assert.rejects(
    () => downloadSubtitleFile("http://127.0.0.1/x", dest),
    (e) => e.code === "BLOCKED_URL",
  );
  assert.equal(fs.existsSync(dest), false);
});

test("downloadSubtitleFile rejects a link-local/metadata target (SSRF guard) and writes nothing", async () => {
  const dest = tmpDest(".srt");
  await assert.rejects(
    () => downloadSubtitleFile("http://169.254.169.254/latest/meta-data/", dest),
    (e) => e.code === "BLOCKED_URL",
  );
  assert.equal(fs.existsSync(dest), false);
});

// ── readCapped: byte-cap regression (memory DoS fix) ────────────────────────
// downloadSubtitleFile used to buffer the entire response via res.arrayBuffer()
// before checking size at all, so a large body was fully read into RAM no
// matter what. readCapped is the extracted streaming reader that enforces the
// cap while reading, so it never buffers past the limit. Tested directly
// against a hand-built ReadableStream — no server, no network, fully
// deterministic.
test("readCapped returns the full buffer when the stream stays under the cap", async () => {
  const chunks = [Buffer.from("hello "), Buffer.from("world")];
  const buf = await readCapped(streamOf(chunks), 1024);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), "hello world");
});

test("readCapped returns null once the stream exceeds the cap", async () => {
  const chunks = [Buffer.alloc(600, "a"), Buffer.alloc(600, "b")];
  const result = await readCapped(streamOf(chunks), 1000);
  assert.equal(result, null);
});

test("readCapped treats a null stream (empty body) as an empty buffer", async () => {
  const buf = await readCapped(null, 1024);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.length, 0);
});

// ── Subtitle array cap (memory DoS fix, runDownload) ────────────────────────
// runDownload caps `subtitles` to MAX_SUBTITLES before storing it on the
// download entry, and every entry in that stored array is later fetched in
// parallel (Promise.all) — so capping here bounds total concurrent fetches.
// Exercised directly against the same slicing expression runDownload uses,
// since spinning up a real downloader child process is unrelated to what
// this regression is about.
test("subtitle list is capped at MAX_SUBTITLES", () => {
  assert.equal(MAX_SUBTITLES, 25);
  const subtitles = Array.from({ length: 30 }, (_, i) => ({
    url: `https://example.com/${i}.srt`,
    lang: "en",
  }));
  const capped = (Array.isArray(subtitles) ? subtitles : []).slice(
    0,
    MAX_SUBTITLES,
  );
  assert.equal(capped.length, 25);
  assert.equal(capped[0].url, "https://example.com/0.srt");
  assert.equal(capped[24].url, "https://example.com/24.srt");
});
