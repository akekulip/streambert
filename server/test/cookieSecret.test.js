"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isInsecureCookieSecret } = require("../lib/cookieSecret");

test("isInsecureCookieSecret rejects unset, empty, and the dev sentinel", () => {
  assert.equal(isInsecureCookieSecret(undefined), true);
  assert.equal(isInsecureCookieSecret(""), true);
  assert.equal(isInsecureCookieSecret("streambert-dev-secret-change-me"), true);
});

test("isInsecureCookieSecret rejects whitespace-only, too-short, and whitespace-padded sentinel values", () => {
  assert.equal(isInsecureCookieSecret(" "), true);
  assert.equal(isInsecureCookieSecret("short"), true);
  assert.equal(isInsecureCookieSecret("streambert-dev-secret-change-me "), true);
});

test("isInsecureCookieSecret accepts a real secret", () => {
  assert.equal(isInsecureCookieSecret("a-long-random-production-secret"), false);
  assert.equal(
    isInsecureCookieSecret("f".repeat(64)), // 64-char hex string, e.g. openssl rand -hex 32
    false,
  );
});
