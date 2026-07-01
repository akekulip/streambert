"use strict";
// Secure key store — replaces Electron safeStorage for the web port.
// Single-user, behind password auth, stored in DATA_DIR/secure.json.
// (Self-host on the user's own box; not OS-encrypted like the desktop build.
//  A future hardening step could encrypt at rest with a server key.)

const fs = require("fs");
const path = require("path");

module.exports = async function (fastify) {
  const dir = fastify.config.DATA_DIR;
  const file = path.join(dir, "secure.json");

  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  const save = (obj) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
  };

  fastify.get("/:key", async (req) => ({
    value: load()[req.params.key] ?? null,
  }));

  fastify.put("/:key", async (req) => {
    const obj = load();
    const v = req.body && req.body.value;
    if (v == null || v === "") delete obj[req.params.key];
    else obj[req.params.key] = v;
    save(obj);
    return { ok: true };
  });
};
