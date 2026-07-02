// One-time fixture generator for the recommendation-engine experiment.
// Builds synthetic user watch histories by seeded random walks over TMDB's
// recommendations graph, and records every TMDB response touched (plus
// /similar + details for all history titles, and a few global lists) into
// fixtures/tmdb-cache.json so run_eval.mjs is fully offline + deterministic.
//
// Usage: node eval/recs/generate_fixtures.mjs
// Needs STREAMBERT_TMDB_TOKEN in the repo root .env (TMDB read-access JWT).
// NOT part of the eval loop — the experiment agent must never run or edit this.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "eval", "recs", "fixtures");

const SEED = 20260701;
const N_USERS = 40;
const FIXED_NOW = Date.UTC(2026, 5, 30, 12, 0, 0); // 2026-06-30T12:00Z
const DAY_MS = 24 * 60 * 60 * 1000;

// ── TMDB client with recording ────────────────────────────────────────────────
function loadToken() {
  const env = readFileSync(join(ROOT, ".env"), "utf8");
  const m = env.match(/^STREAMBERT_TMDB_TOKEN=(.+)$/m);
  if (!m) throw new Error("STREAMBERT_TMDB_TOKEN not found in .env");
  return m[1].trim();
}

const TOKEN = loadToken();
const cache = {};
let apiCalls = 0;

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

function trimResponse(path, data) {
  if (Array.isArray(data.results)) {
    return {
      page: data.page,
      total_pages: data.total_pages,
      results: data.results.map(trimItem),
    };
  }
  // details endpoint
  return {
    id: data.id,
    title: data.title,
    name: data.name,
    genres: data.genres,
    popularity: data.popularity,
    vote_average: data.vote_average,
    vote_count: data.vote_count,
    original_language: data.original_language,
    release_date: data.release_date,
    first_air_date: data.first_air_date,
    runtime: data.runtime,
    number_of_seasons: data.number_of_seasons,
  };
}

async function tmdb(path) {
  if (cache[path]) return cache[path];
  apiCalls++;
  const res = await fetch(`https://api.themoviedb.org/3${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`);
  const data = trimResponse(path, await res.json());
  cache[path] = data;
  await new Promise((r) => setTimeout(r, 30)); // stay well under rate limits
  return data;
}

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ── Taste profiles: TMDB genre ids per media type ─────────────────────────────
const PROFILES = [
  { name: "action-scifi", movie: [28, 878], tv: [10765], tvShare: 0.3 },
  { name: "comedy", movie: [35], tv: [35], tvShare: 0.4 },
  { name: "drama-crime", movie: [18, 80], tv: [18, 80], tvShare: 0.5 },
  { name: "horror-thriller", movie: [27, 53], tv: [9648], tvShare: 0.2 },
  { name: "animation-family", movie: [16, 10751], tv: [16], tvShare: 0.4 },
  { name: "romance-drama", movie: [10749, 18], tv: [18], tvShare: 0.3 },
  { name: "scifi-fantasy-tv", movie: [878, 14], tv: [10765], tvShare: 0.6 },
  { name: "crime-tv", movie: [80], tv: [80, 18], tvShare: 0.7 },
];

async function anchorsFor(profile, type) {
  const genres = profile[type].join(",");
  const data = await tmdb(
    `/discover/${type}?with_genres=${genres}&sort_by=popularity.desc&page=${randInt(1, 2)}`,
  );
  return (data.results || []).slice(0, 12);
}

// Random walk over the recommendations graph starting from an anchor.
async function walkHistory(profile, length) {
  const items = [];
  const seen = new Set();
  let type = rand() < profile.tvShare ? "tv" : "movie";
  let anchors = await anchorsFor(profile, type);
  let current = pick(anchors);

  while (items.length < length) {
    const key = `${type}_${current.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push({ media_type: type, tmdb_id: current.id });
    }
    // Occasionally switch media type or jump back to a fresh anchor.
    if (rand() < 0.15) {
      type = rand() < profile.tvShare ? "tv" : "movie";
      anchors = await anchorsFor(profile, type);
      current = pick(anchors);
      continue;
    }
    const recs = await tmdb(`/${type}/${current.id}/recommendations`);
    const candidates = (recs.results || [])
      .slice(0, 8)
      .filter((r) => !seen.has(`${type}_${r.id}`));
    if (candidates.length === 0) {
      current = pick(anchors);
      continue;
    }
    current = pick(candidates);
  }
  return items;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const users = [];
for (let u = 0; u < N_USERS; u++) {
  const profile = PROFILES[u % PROFILES.length];
  const length = randInt(12, 24);
  const items = await walkHistory(profile, length);
  // Ascending timestamps ending at FIXED_NOW, 0.5–2 days apart.
  let t = FIXED_NOW;
  for (let i = items.length - 1; i >= 0; i--) {
    items[i].watched_at = Math.round(t);
    t -= (0.5 + rand() * 1.5) * DAY_MS;
  }
  users.push({ user: `syn-u${u + 1}`, profile: profile.name, items });
  console.log(`${users[u].user} (${profile.name}): ${items.length} items`);
}

// Ensure /recommendations, /similar and details exist for EVERY history title,
// so the experiment agent can change seed selection / fallbacks freely.
const allTitles = new Set();
for (const u of users)
  for (const it of u.items) allTitles.add(`${it.media_type}_${it.tmdb_id}`);
console.log(`Recording endpoints for ${allTitles.size} unique titles...`);
for (const key of allTitles) {
  const [type, id] = key.split("_");
  await tmdb(`/${type}/${id}/recommendations`);
  await tmdb(`/${type}/${id}/similar`);
  await tmdb(`/${type}/${id}`);
}

// Global lists useful for fallback strategies.
for (const path of [
  "/trending/movie/week",
  "/trending/tv/week",
  "/movie/top_rated",
  "/tv/top_rated",
  "/movie/popular",
  "/tv/popular",
])
  await tmdb(path);

mkdirSync(join(FIXTURES, "synthetic"), { recursive: true });
writeFileSync(
  join(FIXTURES, "synthetic", "histories.json"),
  JSON.stringify(users, null, 1),
);
writeFileSync(join(FIXTURES, "tmdb-cache.json"), JSON.stringify(cache));
writeFileSync(
  join(FIXTURES, "meta.json"),
  JSON.stringify(
    {
      seed: SEED,
      n_users: N_USERS,
      fixed_now: FIXED_NOW,
      unique_titles: allTitles.size,
      cached_paths: Object.keys(cache).length,
      api_calls: apiCalls,
    },
    null, 2,
  ),
);
console.log(
  `Done. ${Object.keys(cache).length} cached paths, ${apiCalls} API calls.`,
);
