"use strict";
// In-memory, single-process login throttle. Keyed by `${username}|${ip}`.
function createLoginThrottle({ max = 5, windowMs = 15 * 60 * 1000, lockoutMs = 60 * 1000 } = {}) {
  const attempts = new Map(); // key -> { count, first, lockedUntil }

  function isLocked(key) {
    const e = attempts.get(key);
    return !!(e && e.lockedUntil > Date.now());
  }

  function registerFailure(key) {
    const now = Date.now();
    let e = attempts.get(key);
    if (!e || now - e.first > windowMs) e = { count: 0, first: now, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= max) e.lockedUntil = now + lockoutMs;
    attempts.set(key, e);
  }

  function reset(key) {
    attempts.delete(key);
  }

  return { isLocked, registerFailure, reset };
}

module.exports = { createLoginThrottle };
