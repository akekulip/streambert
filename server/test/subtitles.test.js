"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { srtToVtt } = require("../lib/subtitles");

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
