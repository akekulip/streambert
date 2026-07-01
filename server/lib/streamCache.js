"use strict";
// Tiny TTL + max-size cache. Insertion order = eviction order (Map).
function createCache({ ttlMs, max }) {
  const m = new Map();
  return {
    get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (Date.now() - e.ts > ttlMs) { m.delete(key); return null; }
      return e.val;
    },
    set(key, val) {
      if (!m.has(key) && m.size >= max) m.delete(m.keys().next().value);
      m.set(key, { val, ts: Date.now() });
    },
    _size: () => m.size,
  };
}
module.exports = { createCache };
