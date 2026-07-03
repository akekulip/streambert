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
const { downloadSubtitleFile } = require("../lib/downloads");

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
