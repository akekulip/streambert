"use strict";
// Predictive stream pre-warming (roadmap ①). After a user's bootstrap,
// quietly pre-extract the streams they're most likely to play next — resume
// points, the imminent next episode, top recommendations — so pressing play
// starts instantly instead of waiting out a multi-second extraction.
// Deliberately gentle: one global serial queue, small caps, per-user
// cooldown — the extractor is a memory-capped headless-Chrome sidecar.

const { jobKey } = require("./extract");

const COOLDOWN_MS = 30 * 60 * 1000;
const START_DELAY_MS = 15 * 1000; // let the user's recs row land first
const JOB_GAP_MS = 1500;
const MAX_JOBS = 6;
const NEXT_EP_PCT = 85; // autoplay-next territory — warm the next episode

function createPrewarm({
  db,
  extractClient,
  recsCache,
  fetchTmdb,
  log = console,
  delayMs = START_DELAY_MS,
  gapMs = JOB_GAP_MS,
}) {
  const lastRun = new Map(); // userId -> ts
  const stats = { scheduled: 0, warmed: 0, cachedSkips: 0, errors: 0, lastAt: null };
  let chain = Promise.resolve(); // global serial queue across users

  // unref so pending waits never hold the process open (tests, shutdown);
  // zero-delay resolves synchronously or an unref'd 0ms timer may never fire.
  const sleep = (ms) =>
    ms <= 0
      ? Promise.resolve()
      : new Promise((r) => {
          const t = setTimeout(r, ms);
          if (t.unref) t.unref();
        });

  const progressKey = (h) =>
    h.media_type === "movie"
      ? `movie_${h.tmdb_id}`
      : `tv_${h.tmdb_id}_s${h.season}e${h.episode}`;

  async function nextEpisode(h) {
    try {
      const season = await fetchTmdb(`/tv/${h.tmdb_id}/season/${h.season}`);
      if ((season.episodes || []).some((e) => e.episode_number === h.episode + 1))
        return { type: "tv", tmdb: h.tmdb_id, season: h.season, episode: h.episode + 1 };
      const show = await fetchTmdb(`/tv/${h.tmdb_id}`);
      if ((show.seasons || []).some((s) => s.season_number === h.season + 1))
        return { type: "tv", tmdb: h.tmdb_id, season: h.season + 1, episode: 1 };
    } catch {
      /* metadata unavailable — skip the next-episode job */
    }
    return null;
  }

  async function deriveJobs(userId) {
    const history = db
      .prepare(
        "SELECT media_type, tmdb_id, season, episode FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 10",
      )
      .all(userId);
    const watched = new Set(
      db.prepare("SELECT media_key FROM watched_titles WHERE user_id = ?").all(userId).map((r) => r.media_key),
    );
    const progress = new Map(
      db.prepare("SELECT media_key, pct FROM watch_progress WHERE user_id = ?").all(userId).map((r) => [r.media_key, r.pct]),
    );

    const jobs = [];
    // Continue Watching — same rule as the client: unwatched, pct null or 2–98.
    let cw = 0;
    for (const h of history) {
      if (cw >= 3) break;
      const key = progressKey(h);
      if (watched.has(key)) continue;
      const pct = progress.get(key);
      if (pct != null && (pct <= 2 || pct >= 98)) continue;
      cw++;
      if (h.media_type === "movie") {
        jobs.push({ type: "movie", tmdb: h.tmdb_id });
      } else if (h.season != null && h.episode != null) {
        jobs.push({ type: "tv", tmdb: h.tmdb_id, season: h.season, episode: h.episode });
        if (pct != null && pct >= NEXT_EP_PCT) {
          const next = await nextEpisode(h);
          if (next) jobs.push(next);
        }
      }
    }
    // Top recommendations: movie → itself, tv → s1e1.
    const recs = recsCache && recsCache.peek ? recsCache.peek(userId) : null;
    for (const r of (recs || []).slice(0, 3)) {
      if (r.media_type === "tv") jobs.push({ type: "tv", tmdb: r.id, season: 1, episode: 1 });
      else jobs.push({ type: "movie", tmdb: r.id });
    }
    // Dedupe, drop already-cached, cap.
    const seen = new Set();
    const out = [];
    for (const j of jobs) {
      const k = jobKey(j);
      if (seen.has(k)) continue;
      seen.add(k);
      if (extractClient.isCached(j)) {
        stats.cachedSkips++;
        continue;
      }
      out.push(j);
      if (out.length >= MAX_JOBS) break;
    }
    return out;
  }

  function schedule(userId) {
    if (process.env.STREAMBERT_PREWARM === "0") return chain;
    const last = lastRun.get(userId) || 0;
    if (Date.now() - last < COOLDOWN_MS) return chain;
    lastRun.set(userId, Date.now());
    stats.scheduled++;
    chain = chain.then(async () => {
      await sleep(delayMs);
      try {
        for (const job of await deriveJobs(userId)) {
          const r = await extractClient.extract(job);
          if (r.ok && !r.cached) stats.warmed++;
          else if (!r.ok) stats.errors++;
          await sleep(gapMs);
        }
        stats.lastAt = Date.now();
      } catch (e) {
        stats.errors++;
        if (log.warn) log.warn(`prewarm failed for user ${userId}: ${e.message}`);
      }
    });
    return chain;
  }

  return { schedule, stats: () => ({ ...stats }) };
}

module.exports = { createPrewarm };
