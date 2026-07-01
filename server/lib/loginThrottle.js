"use strict";
// In-memory, single-process login throttle. Keyed by `${username}|${ip}`.
function createLoginThrottle({
  max = 5,
  windowMs = 15 * 60 * 1000,
  lockoutMs = 60 * 1000,
  maxEntries = 10000,
} = {}) {
  const attempts = new Map(); // key -> { count, first, lockedUntil }

  function isLocked(key) {
    const e = attempts.get(key);
    return !!(e && e.lockedUntil > Date.now());
  }

  // Bound memory: when the map grows past maxEntries, drop entries whose window
  // has elapsed and that aren't currently locked. Prevents unbounded growth from
  // an attacker spraying distinct usernames against the public login endpoint.
  function prune(now) {
    for (const [k, e] of attempts) {
      if (e.lockedUntil <= now && now - e.first > windowMs) attempts.delete(k);
    }
  }

  function registerFailure(key) {
    const now = Date.now();
    if (attempts.size >= maxEntries) prune(now);
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
