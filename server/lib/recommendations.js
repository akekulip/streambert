"use strict";

// Recommendation engine (v2 experiment target; baseline is a port of the
// HomePage.jsx v1 logic). Pure module: no network, no DB — the caller injects
// `fetchTmdb` and history rows, so the same code runs in the app and in the
// offline eval harness (eval/recs/run_eval.mjs).

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function titleKey(mediaType, tmdbId) {
  return `${mediaType || "movie"}_${tmdbId}`;
}

// Up to `count` unique, most-recently-watched titles (last 30 days), newest
// first — used to seed recommendations.
function recentSeeds(history, now, count) {
  const cutoff = now - THIRTY_DAYS_MS;
  const recent = history
    .filter((h) => h.watched_at && h.watched_at > cutoff)
    .sort((a, b) => b.watched_at - a.watched_at);
  const seen = new Set();
  const unique = [];
  for (const item of recent) {
    const key = titleKey(item.media_type, item.tmdb_id);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= count) break;
  }
  return unique;
}

/**
 * Rank personalised recommendations from a user's watch history.
 *
 * @param {Object} opts
 * @param {Array}  opts.history   rows { media_type, tmdb_id, watched_at, ... }
 * @param {Function} opts.fetchTmdb  async (path) => parsed TMDB JSON
 *                                   (e.g. "/movie/550/recommendations")
 * @param {number} [opts.limit=20]
 * @param {number} [opts.now=Date.now()]
 * @returns {Promise<Array<{media_type: string, id: number}>>} ranked list
 */
async function recommend({ history, fetchTmdb, limit = 20, now = Date.now() }) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const sources = recentSeeds(history, now, 5);
  if (sources.length === 0) return [];

  // Exclude titles the user has already watched.
  const watchedKeys = new Set(
    history.map((h) => titleKey(h.media_type, h.tmdb_id)),
  );

  const fetchOne = (source) => {
    const type = source.media_type === "tv" ? "tv" : "movie";
    return fetchTmdb(`/${type}/${source.tmdb_id}/recommendations`)
      .then((data) => {
        const results = (data.results || []).map((i) => ({
          ...i,
          media_type: type,
        }));
        if (results.length > 0) return results;
        // Fall back to /similar when /recommendations is empty.
        return fetchTmdb(`/${type}/${source.tmdb_id}/similar`).then((d2) =>
          (d2.results || []).map((i) => ({ ...i, media_type: type })),
        );
      })
      .catch(() => []);
  };

  const lists = await Promise.all(sources.map(fetchOne));
  // Consensus-weighted ranking: the newest seed keeps primacy (recency is the
  // strongest signal), but titles recommended by several recent seeds get a
  // cumulative boost so cross-seed agreement can outrank the newest seed's
  // deep tail. Ties keep insertion (recency) order.
  const SEED_WEIGHT = [1, 0.35, 0.3, 0.25, 0.2];
  const scored = new Map();
  lists.forEach((list, s) => {
    const w = SEED_WEIGHT[s] ?? 0.15;
    list.forEach((item, rank) => {
      const key = titleKey(item.media_type, item.id);
      if (watchedKeys.has(key)) return;
      const gain = w * Math.max(0, 1 - rank / 25);
      const prev = scored.get(key);
      if (prev) prev.score += gain;
      else scored.set(key, { media_type: item.media_type, id: item.id, score: gain });
    });
  });
  // Hybrid: the newest seed's top picks stay verbatim (its native TMDB order
  // is the best next-watch predictor); consensus ranking orders only the rest
  // of the row.
  const HEAD_FROM_NEWEST = 8;
  const head = [];
  const headKeys = new Set();
  for (const item of lists[0] || []) {
    const key = titleKey(item.media_type, item.id);
    if (watchedKeys.has(key) || headKeys.has(key)) continue;
    headKeys.add(key);
    head.push({ media_type: item.media_type, id: item.id });
    if (head.length >= HEAD_FROM_NEWEST) break;
  }
  const rest = [...scored.values()]
    .filter((i) => !headKeys.has(titleKey(i.media_type, i.id)))
    .sort((a, b) => b.score - a.score)
    .map(({ media_type, id }) => ({ media_type, id }));
  return [...head, ...rest].slice(0, limit);
}

module.exports = { recommend, titleKey };
