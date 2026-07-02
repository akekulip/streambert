// Harvest real user watch histories into eval fixtures.
//
// Pulls the history table from the production container (anonymized: dense
// user indexes, no usernames/titles), writes fixtures/real/histories.json,
// and records any TMDB endpoints missing from fixtures/tmdb-cache.json for
// the harvested titles — so run_eval.mjs picks the real users up as a second
// eval signal (`real_hit_rate`) with zero further wiring.
//
// Usage: node eval/recs/harvest_real.mjs
//   env overrides: STREAMBERT_HARVEST_SSH (default decps@10.10.54.19)
//                  STREAMBERT_HARVEST_CONTAINER (default streambert)
// Needs SSH access to the prod host and STREAMBERT_TMDB_TOKEN in .env.
// NOT part of the eval loop — the experiment agent must never run or edit this.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "eval", "recs", "fixtures");
const SSH_HOST = process.env.STREAMBERT_HARVEST_SSH || "decps@10.10.54.19";
const CONTAINER = process.env.STREAMBERT_HARVEST_CONTAINER || "streambert";

// ── 1. Export anonymized history from the prod container ─────────────────────
const EXPORT_SCRIPT = `
const db = require("better-sqlite3")("/data/streambert.db", { readonly: true });
const rows = db.prepare(
  "SELECT user_id, media_type, tmdb_id, season, episode, watched_at FROM history ORDER BY user_id, watched_at"
).all();
const map = new Map();
for (const r of rows) if (!map.has(r.user_id)) map.set(r.user_id, "real-u" + (map.size + 1));
const users = [...map.entries()].map(([uid, anon]) => ({
  user: anon,
  items: rows.filter((r) => r.user_id === uid).map(
    ({ media_type, tmdb_id, season, episode, watched_at }) =>
      ({ media_type, tmdb_id, season, episode, watched_at })),
}));
console.log(JSON.stringify(users));
`;

console.log(`Harvesting from ${SSH_HOST} (container: ${CONTAINER})...`);
const raw = execFileSync(
  "ssh",
  ["-o", "BatchMode=yes", SSH_HOST, "docker", "exec", "-i", "-w", "/app/server", CONTAINER, "node", "-"],
  { input: EXPORT_SCRIPT, encoding: "utf8", timeout: 30000 },
);
const users = JSON.parse(raw);
console.log(`${users.length} users, ${users.reduce((a, u) => a + u.items.length, 0)} history rows`);

mkdirSync(join(FIXTURES, "real"), { recursive: true });
writeFileSync(join(FIXTURES, "real", "histories.json"), JSON.stringify(users, null, 1));

if (users.length === 0) {
  console.log("History table is empty — nothing to record. (Have users done the browser migration yet?)");
  process.exit(0);
}

// ── 2. Record missing TMDB fixtures for the harvested titles ─────────────────
const env = readFileSync(join(ROOT, ".env"), "utf8");
const tokenMatch = env.match(/^STREAMBERT_TMDB_TOKEN=(.+)$/m);
if (!tokenMatch) throw new Error("STREAMBERT_TMDB_TOKEN not found in .env");
const TOKEN = tokenMatch[1].trim();

const cachePath = join(FIXTURES, "tmdb-cache.json");
const cache = JSON.parse(readFileSync(cachePath, "utf8"));

function trimItem(i) {
  const out = {
    id: i.id,
    genre_ids: i.genre_ids,
    popularity: i.popularity,
    vote_average: i.vote_average,
    vote_count: i.vote_count,
    original_language: i.original_language,
  };
  if (i.title !== undefined) out.title = i.title;
  if (i.name !== undefined) out.name = i.name;
  if (i.release_date !== undefined) out.release_date = i.release_date;
  if (i.first_air_date !== undefined) out.first_air_date = i.first_air_date;
  return out;
}

async function record(path) {
  if (cache[path]) return false;
  const res = await fetch(`https://api.themoviedb.org/3${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, accept: "application/json" },
  });
  if (!res.ok) {
    console.warn(`  skip ${path}: TMDB ${res.status}`);
    return false;
  }
  const data = await res.json();
  cache[path] = Array.isArray(data.results)
    ? { page: data.page, total_pages: data.total_pages, results: data.results.map(trimItem) }
    : {
        id: data.id, title: data.title, name: data.name, genres: data.genres,
        popularity: data.popularity, vote_average: data.vote_average,
        vote_count: data.vote_count, original_language: data.original_language,
        release_date: data.release_date, first_air_date: data.first_air_date,
        runtime: data.runtime, number_of_seasons: data.number_of_seasons,
      };
  await new Promise((r) => setTimeout(r, 30));
  return true;
}

const titles = new Set();
for (const u of users)
  for (const it of u.items) titles.add(`${it.media_type === "tv" ? "tv" : "movie"}_${it.tmdb_id}`);

let recorded = 0;
for (const key of titles) {
  const [type, id] = key.split("_");
  for (const suffix of ["/recommendations", "/similar", ""])
    if (await record(`/${type}/${id}${suffix}`)) recorded++;
}
writeFileSync(cachePath, JSON.stringify(cache));
console.log(`Recorded ${recorded} new TMDB paths for ${titles.size} titles.`);
console.log("Done — run_eval.mjs will now include real users (real_hit_rate).");
