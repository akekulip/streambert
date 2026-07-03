"use strict";

const DEV_SENTINEL = "streambert-dev-secret-change-me";

// True when `s` is unset/empty or is the source-visible dev fallback — i.e. not
// safe to sign real sessions with.
function isInsecureCookieSecret(s) {
  return !s || s === DEV_SENTINEL;
}

module.exports = { isInsecureCookieSecret, DEV_SENTINEL };
