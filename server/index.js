"use strict";
// Streambert web-port backend. Bootstraps the DB + admin, then serves the built
// frontend (../dist) + /api/*. Auth: per-user accounts (see docs).

const path = require("path");

// Load a repo-root .env (KEY=VALUE per line) into process.env for local /
// `node server/index.js` runs. Under Docker, Compose injects these vars directly
// and no .env is copied into the image (see .dockerignore) — the loader simply
// no-ops. Existing process.env values always win over the file.
function loadDotEnv() {
  const fs = require("fs");
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  } catch {
    return; // no .env present — nothing to load
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue; // blanks, comments (#...) don't match
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadDotEnv();

const { openDb } = require("./lib/db");
const { bootstrapAdmin } = require("./lib/users");
const { createLoginThrottle } = require("./lib/loginThrottle");
const { buildApp } = require("./app");

const COOKIE_SECRET = process.env.STREAMBERT_COOKIE_SECRET || "streambert-dev-secret-change-me";
const DIST_DIR = path.join(__dirname, "..", "dist");
const DATA_DIR = process.env.STREAMBERT_DATA || path.join(__dirname, "..", "data");
const PORT = Number(process.env.PORT || 8787);

async function main() {
  require("fs").mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(path.join(DATA_DIR, "streambert.db"));
  const created = bootstrapAdmin(db, {
    adminUser: process.env.STREAMBERT_ADMIN_USER,
    adminPassword: process.env.STREAMBERT_ADMIN_PASSWORD || process.env.STREAMBERT_PASSWORD,
  });
  if (created) console.log(`[bootstrap] created initial admin user "${created.username}"`);

  const app = await buildApp({
    db, cookieSecret: COOKIE_SECRET,
    loginThrottle: createLoginThrottle(),
    dataDir: DATA_DIR, distDir: DIST_DIR,
  });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`Streambert web on :${PORT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
