// Offline eval for server/lib/recommendations.js — the autoresearch metric.
//
// Leave-last-K-out replay: for each fixture user and each of their last 3
// history positions, run the engine on the prefix and check whether the
// held-out title appears in the top-20 recommendations. Fully deterministic:
// TMDB responses come from fixtures/tmdb-cache.json (recorded once by
// generate_fixtures.mjs), and `now` is always the held-out item's timestamp.
//
// READ-ONLY for the experiment agent: only server/lib/recommendations.js may
// change. Real-user fixtures (fixtures/real/histories.json) are included
// automatically once that file exists.
//
// Usage: node eval/recs/run_eval.mjs
// Output: hit_rate_at_20: <0..1>   (higher is better)

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { recommend, titleKey } = require(
  join(HERE, "..", "..", "server", "lib", "recommendations.js"),
);

const K_HOLDOUTS = 3;
const MIN_HISTORY = 8;
const LIMIT = 20;

const cache = JSON.parse(
  readFileSync(join(HERE, "fixtures", "tmdb-cache.json"), "utf8"),
);
const fetchTmdb = async (path) => {
  if (!(path in cache)) throw new Error(`no fixture for TMDB path: ${path}`);
  return cache[path];
};

function loadUsers(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}
const synthetic = loadUsers(join(HERE, "fixtures", "synthetic", "histories.json"));
const real = loadUsers(join(HERE, "fixtures", "real", "histories.json"));
if (synthetic.length === 0) {
  console.error("No synthetic fixtures. Run: node eval/recs/generate_fixtures.mjs");
  process.exit(1);
}

async function scoreUsers(users) {
  let hits = 0;
  let hits10 = 0;
  let holdouts = 0;
  for (const user of users) {
    const items = [...user.items].sort((a, b) => a.watched_at - b.watched_at);
    if (items.length < MIN_HISTORY) continue;
    for (let k = 1; k <= K_HOLDOUTS; k++) {
      const pos = items.length - k;
      const heldout = items[pos];
      const prefix = items.slice(0, pos);
      const heldKey = titleKey(heldout.media_type, heldout.tmdb_id);
      // A rewatch can't be recommended (engine excludes watched) — skip.
      if (prefix.some((i) => titleKey(i.media_type, i.tmdb_id) === heldKey))
        continue;
      const recs = await recommend({
        history: prefix,
        fetchTmdb,
        limit: LIMIT,
        now: heldout.watched_at,
      });
      holdouts++;
      const rank = recs.findIndex(
        (r) => titleKey(r.media_type, r.id) === heldKey,
      );
      if (rank >= 0) hits++;
      if (rank >= 0 && rank < 10) hits10++;
    }
  }
  return { hits, hits10, holdouts };
}

const syn = await scoreUsers(synthetic);
const re = await scoreUsers(real);
const rate = (s) => (s.holdouts === 0 ? null : s.hits / s.holdouts);

console.log(
  `synthetic_hit_rate: ${rate(syn)?.toFixed(4) ?? "n/a"} (${syn.hits}/${syn.holdouts})`,
);
console.log(
  `real_hit_rate: ${rate(re)?.toFixed(4) ?? "n/a"} (${re.hits}/${re.holdouts})`,
);
const total = {
  hits: syn.hits + re.hits,
  hits10: syn.hits10 + re.hits10,
  holdouts: syn.holdouts + re.holdouts,
};
console.log(`n_holdouts: ${total.holdouts}`);
console.log(`secondary_hit_rate_at_10: ${(total.hits10 / total.holdouts).toFixed(4)}`);
console.log(`hit_rate_at_20: ${rate(total).toFixed(4)}`);
