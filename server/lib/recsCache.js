"use strict";
// Per-user recommendation result cache. Decorated on the fastify root in
// app.js so both the recommendations route and the admin routes see it
// (fastify plugin encapsulation would hide a route-scoped decoration).
// Entries bust when the user's newest history row changes or the TTL lapses.

const RESULT_TTL_MS = 15 * 60 * 1000;

function createRecsCache() {
  const cache = new Map(); // userId -> { at, newest, results }
  return {
    lookup(userId, newest) {
      const hit = cache.get(userId);
      if (!hit || hit.newest !== newest || Date.now() - hit.at > RESULT_TTL_MS) {
        return null;
      }
      return hit.results;
    },
    store(userId, newest, results) {
      cache.set(userId, { at: Date.now(), newest, results });
    },
    stats: () => ({ users: cache.size }),
    clear: () => cache.clear(),
  };
}

module.exports = { createRecsCache };
