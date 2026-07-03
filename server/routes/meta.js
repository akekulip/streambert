"use strict";
// App meta: version + block stats (stubbed on web). Registered at /api.

let version = "0.0.0";
try {
  version = require("../../package.json").version || version;
} catch {
  /* ignore */
}

module.exports = async function (fastify) {
  fastify.get("/version", async () => ({ version }));
  fastify.get("/blockstats", async () => ({ ads: 0, trackers: 0, total: 0 }));

  function normLink(v, kind) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (kind === "whatsapp") { const d = s.replace(/[^0-9]/g, ""); return d ? `https://wa.me/${d}` : null; }
    return `https://t.me/${s.replace(/^@/, "")}`;
  }
  fastify.get("/config", async () => ({
    whatsapp: normLink(process.env.STREAMBERT_ADMIN_WHATSAPP, "whatsapp"),
    telegram: normLink(process.env.STREAMBERT_ADMIN_TELEGRAM, "telegram"),
    // Whether the /vzy Videasy same-origin proxy is registered server-side
    // (see app.js — off by default, C5). Lets the client avoid offering/using
    // the Videasy-via-proxy path when the server won't actually serve it.
    vzy: process.env.STREAMBERT_VZY === "1",
  }));
};
