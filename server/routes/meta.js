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
};
