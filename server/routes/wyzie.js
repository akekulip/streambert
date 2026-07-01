"use strict";
// ── Routes: /api/wyzie ────────────────────────────────────────────────────────
// Port of the "wyzie-validate-key" IPC handler (Electron index.js) to Fastify.
// Relative route (prefixed with /api/wyzie by server/index.js):
//   POST /validate -> wyzieValidateKey(key)  body: { key }
//
// (wyzieOpenRedeem is handled entirely client-side by the web shim via
//  window.open — no server route is needed.)

const subs = require("../lib/subtitles");

module.exports = async function (fastify) {
  fastify.post("/validate", async (req) => {
    const { key } = req.body || {};
    return subs.wyzieValidateKey(key);
  });
};
