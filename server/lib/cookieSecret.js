"use strict";

const DEV_SENTINEL = "streambert-dev-secret-change-me";

// True when `s` is unset/empty/whitespace, too short, or is the source-visible
// dev fallback (ignoring surrounding whitespace) — i.e. not safe to sign real
// sessions with.
function isInsecureCookieSecret(s) {
  if (!s || typeof s !== "string") return true;
  const t = s.trim();
  if (t.length < 16) return true; // too short / whitespace-only
  if (t === DEV_SENTINEL) return true; // the dev sentinel
  return false;
}

module.exports = { isInsecureCookieSecret, DEV_SENTINEL };
