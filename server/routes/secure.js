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

  // Env-provided defaults for sensitive keys. Lets a self-hoster pre-seed a
  // value via .env (e.g. the TMDB Read Access Token) so the in-app setup screen
  // never appears. A value saved through the UI is written to secure.json and
  // takes precedence over the env default.
  const envFallback = {
    apikey: process.env.STREAMBERT_TMDB_TOKEN || process.env.TMDB_TOKEN || null,
  };

  fastify.get("/:key", async (req) => {
    const key = req.params.key;
    return { value: load()[key] ?? envFallback[key] ?? null };
  });

  fastify.put("/:key", async (req) => {
    const obj = load();
    const v = req.body && req.body.value;
    if (v == null || v === "") delete obj[req.params.key];
    else obj[req.params.key] = v;
    save(obj);
    return { ok: true };
  });
};
