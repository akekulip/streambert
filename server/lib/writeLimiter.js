"use strict";
// In-memory, single-process, fixed-window write limiter keyed by user id.
// Guards /api/state mutations against runaway clients (spec: ~120/min).
function createWriteLimiter({ max = 120, windowMs = 60 * 1000, maxEntries = 10000 } = {}) {
  const windows = new Map(); // userId -> { count, start }

  function allow(userId) {
    const now = Date.now();
    if (windows.size >= maxEntries) {
      for (const [k, w] of windows) {
        if (now - w.start > windowMs) windows.delete(k);
      }
    }
    let w = windows.get(userId);
    if (!w || now - w.start > windowMs) {
      w = { count: 0, start: now };
      windows.set(userId, w);
    }
    w.count += 1;
    return w.count <= max;
  }

  return { allow };
}

module.exports = { createWriteLimiter };
