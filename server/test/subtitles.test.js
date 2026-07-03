"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  srtToVtt,
  deleteSubtitleFile,
  downloadSubtitlesForFile,
  extractFirstSubtitleFromZip,
} = require("../lib/subtitles");

// ── Test helpers ───────────────────────────────────────────────────────────
function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "streambert-subtitles-test-"));
}

// Builds a minimal single-entry ZIP buffer (stored, no compression) matching
// the layout extractFirstSubtitleFromZip parses: a 30-byte local file header
// followed by the raw file name and raw data.
function buildZipEntry(fileName, data) {
  const nameBuf = Buffer.from(fileName, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed to extract
  header.writeUInt16LE(0, 6); // general purpose bit flag
  header.writeUInt16LE(0, 8); // compression method: 0 = stored
  header.writeUInt16LE(0, 10); // last mod file time
  header.writeUInt16LE(0, 12); // last mod file date
  header.writeUInt32LE(0, 14); // crc-32
  header.writeUInt32LE(data.length, 18); // compressed size
  header.writeUInt32LE(data.length, 22); // uncompressed size
  header.writeUInt16LE(nameBuf.length, 26); // file name length
  header.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([header, nameBuf, data]);
}

test("srtToVtt prepends WEBVTT header and converts comma timestamps to dots", () => {
  const srt =
    "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello world\r\n\r\n" +
    "2\r\n00:00:05,500 --> 00:00:08,250\r\nSecond line\r\n";
  const vtt = srtToVtt(srt);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.ok(vtt.includes("00:00:01.000 --> 00:00:04.000"));
  assert.ok(vtt.includes("00:00:05.500 --> 00:00:08.250"));
  assert.ok(!vtt.includes(",000"));
  assert.ok(vtt.includes("Hello world"));
});

test("srtToVtt is idempotent for already-WEBVTT input", () => {
  const already = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n";
  const out = srtToVtt(already);
  assert.match(out, /^WEBVTT/);
  // A single WEBVTT header, not a doubled one.
  assert.equal((out.match(/WEBVTT/g) || []).length, 1);
  assert.ok(out.includes("00:00:01.000 --> 00:00:02.000"));
});

test("srtToVtt strips a leading BOM and normalizes CRLF", () => {
  const srt = "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nBom test\r\n";
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(!vtt.includes("\r"));
  assert.ok(!vtt.includes("﻿"));
});

// ── C2 hardening: path containment on subtitle write/delete ────────────────

test("deleteSubtitleFile rejects a path outside the allowed dataDir and does not unlink", () => {
  const dataDir = makeTempDataDir();
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "streambert-outside-"),
  );
  const outsidePath = path.join(outsideDir, "protected.srt");
  fs.writeFileSync(outsidePath, "do not delete me");

  const result = deleteSubtitleFile({ subtitlePath: outsidePath }, { dataDir });

  assert.equal(result.ok, false);
  assert.ok(
    fs.existsSync(outsidePath),
    "file outside the allowed dataDir must survive",
  );
});

test("deleteSubtitleFile rejects an absolute path like /etc/passwd", () => {
  // Never risk an actual unlink of /etc/passwd if this suite is ever run as
  // root (e.g. a root Docker CI image) — as non-root the OS denies it anyway,
  // so skipping under root loses no coverage (the "outside dataDir" test above
  // already proves the containment guard rejects external paths).
  if (process.getuid && process.getuid() === 0) return;
  const dataDir = makeTempDataDir();

  const result = deleteSubtitleFile(
    { subtitlePath: "/etc/passwd" },
    { dataDir },
  );

  assert.equal(result.ok, false);
  assert.ok(fs.existsSync("/etc/passwd"), "must never touch /etc/passwd");
});

test("deleteSubtitleFile removes a path inside the allowed subtitles dir", () => {
  const dataDir = makeTempDataDir();
  const subsDir = path.join(dataDir, "subtitles");
  fs.mkdirSync(subsDir, { recursive: true });
  const insidePath = path.join(subsDir, "movie.en.srt");
  fs.writeFileSync(insidePath, "1\n00:00:01,000 --> 00:00:02,000\nHi\n");

  const result = deleteSubtitleFile({ subtitlePath: insidePath }, { dataDir });

  assert.equal(result.ok, true);
  assert.ok(
    !fs.existsSync(insidePath),
    "file inside the allowed subtitles dir should be removed",
  );
});

test("deleteSubtitleFile removes a path inside the allowed downloads dir", () => {
  const dataDir = makeTempDataDir();
  const downloadsDir = path.join(dataDir, "downloads");
  fs.mkdirSync(downloadsDir, { recursive: true });
  const insidePath = path.join(downloadsDir, "movie.en.srt");
  fs.writeFileSync(insidePath, "1\n00:00:01,000 --> 00:00:02,000\nHi\n");

  const result = deleteSubtitleFile({ subtitlePath: insidePath }, { dataDir });

  assert.equal(result.ok, true);
  assert.ok(!fs.existsSync(insidePath));
});

test("downloadSubtitlesForFile rejects a filePath outside the downloads dir", async () => {
  const dataDir = makeTempDataDir();
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "streambert-outside-"),
  );
  const outsideFilePath = path.join(outsideDir, "movie.mp4");
  fs.writeFileSync(outsideFilePath, "fake video");

  const result = await downloadSubtitlesForFile(
    {
      filePath: outsideFilePath,
      selectedSubs: [{ file_id: "wyzie_0_x", direct_url: "https://example.com/x.srt" }],
    },
    { dataDir },
  );

  assert.equal(result.ok, false);
  assert.ok(
    !fs.readdirSync(outsideDir).some((f) => f !== "movie.mp4"),
    "no subtitle file should be written outside the downloads dir",
  );
});

test("downloadSubtitlesForFile accepts a filePath inside the downloads dir", async () => {
  const dataDir = makeTempDataDir();
  const downloadsDir = path.join(dataDir, "downloads");
  fs.mkdirSync(downloadsDir, { recursive: true });
  const filePath = path.join(downloadsDir, "movie.mp4");
  fs.writeFileSync(filePath, "fake video");

  const result = await downloadSubtitlesForFile(
    { filePath, selectedSubs: [] },
    { dataDir },
  );

  assert.equal(result.ok, true);
});

test("extractFirstSubtitleFromZip strips zip-slip traversal from the entry name", () => {
  const data = Buffer.from("WEBVTT\n\nfake");
  const zipBuf = buildZipEntry("../../evil.srt", data);

  const extracted = extractFirstSubtitleFromZip(zipBuf);

  assert.ok(extracted, "a valid stored .srt entry should be extracted");
  assert.equal(extracted.name, "evil.srt");
  assert.ok(!extracted.name.includes(".."));
  assert.ok(!extracted.name.includes("/"));
});

test("extractFirstSubtitleFromZip strips a leading absolute-path entry name", () => {
  const data = Buffer.from("WEBVTT\n\nfake");
  const zipBuf = buildZipEntry("/etc/evil.vtt", data);

  const extracted = extractFirstSubtitleFromZip(zipBuf);

  assert.ok(extracted);
  assert.equal(extracted.name, "evil.vtt");
});
