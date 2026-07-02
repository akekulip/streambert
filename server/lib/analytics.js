"use strict";
// Household analytics (roadmap ③) — pure SQL aggregations over watch_events
// (the append-only log written by addHistory; the history table is an
// upsert-per-title snapshot and can't count binges). No fastify coupling so
// everything is unit-testable.

const DAY_MS = 24 * 60 * 60 * 1000;

function getAnalytics(db, { days = 30, now = Date.now() } = {}) {
  const since = now - days * DAY_MS;

  // Watch events per UTC calendar day, zero-filled across the window.
  const byDay = new Map(
    db
      .prepare(
        `SELECT date(watched_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
           FROM watch_events WHERE watched_at > ? GROUP BY day`,
      )
      .all(since)
      .map((r) => [r.day, r.count]),
  );
  const watchesPerDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    watchesPerDay.push({ day, count: byDay.get(day) || 0 });
  }

  // Titles come from the history snapshot (events don't carry them).
  const topTitles = db
    .prepare(
      `SELECT e.media_type, e.tmdb_id, COUNT(*) AS count,
              (SELECT title FROM history h
                WHERE h.media_type = e.media_type AND h.tmdb_id = e.tmdb_id
                  AND h.title IS NOT NULL LIMIT 1) AS title
         FROM watch_events e WHERE e.watched_at > ?
        GROUP BY e.media_type, e.tmdb_id
        ORDER BY count DESC, MAX(e.watched_at) DESC LIMIT 10`,
    )
    .all(since);

  const activeUsers = db
    .prepare(
      `SELECT u.username, COUNT(*) AS count, MAX(e.watched_at) AS last
         FROM watch_events e JOIN users u ON u.id = e.user_id
        WHERE e.watched_at > ? GROUP BY e.user_id
        ORDER BY count DESC LIMIT 10`,
    )
    .all(since);

  const typeSplit = { movie: 0, tv: 0 };
  for (const r of db
    .prepare(
      "SELECT media_type, COUNT(*) AS c FROM watch_events WHERE watched_at > ? GROUP BY media_type",
    )
    .all(since)) {
    typeSplit[r.media_type] = r.c;
  }

  const activeUsers7d = db
    .prepare("SELECT COUNT(DISTINCT user_id) AS c FROM watch_events WHERE watched_at > ?")
    .get(now - 7 * DAY_MS).c;

  return {
    days,
    watchesPerDay,
    topTitles,
    activeUsers,
    typeSplit,
    totals: {
      watches: watchesPerDay.reduce((a, d) => a + d.count, 0),
      activeUsers7d,
    },
  };
}

module.exports = { getAnalytics };
