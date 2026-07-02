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
  const seen = new Set();
  const deduped = [];
  for (const item of lists.flat()) {
    const key = titleKey(item.media_type, item.id);
    if (seen.has(key) || watchedKeys.has(key)) continue;
    seen.add(key);
    deduped.push({ media_type: item.media_type, id: item.id });
  }
  return deduped.slice(0, limit);
}

module.exports = { recommend, titleKey };
