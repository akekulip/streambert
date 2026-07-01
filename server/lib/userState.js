"use strict";
// Per-user state accessors (Phase 2). Pure functions over better-sqlite3;
// no fastify coupling so merge rules are unit-testable.

const HISTORY_CAP = 500;
const HISTORY_PAGE = 50;

// "movie_550" | "tv_456" → { media_type, tmdb_id }. History/library keys only —
// progress/watched media_key values are opaque strings.
function parseTitleKey(key) {
  const i = String(key).indexOf("_");
  const media_type = i > 0 ? key.slice(0, i) : "";
  const tmdb_id = Number(key.slice(i + 1));
  if ((media_type !== "movie" && media_type !== "tv") || !Number.isInteger(tmdb_id)) {
    const err = new Error(`bad key: ${key}`);
    err.code = "BADKEY";
    throw err;
  }
  return { media_type, tmdb_id };
}

function getBootstrap(db, userId) {
  const progress = {};
  for (const r of db.prepare("SELECT media_key, pct FROM watch_progress WHERE user_id = ?").all(userId)) {
    progress[r.media_key] = r.pct;
  }
  const watched = {};
  for (const r of db.prepare("SELECT media_key FROM watched_titles WHERE user_id = ?").all(userId)) {
    watched[r.media_key] = true;
  }
  const history = db
    .prepare("SELECT * FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT ?")
    .all(userId, HISTORY_PAGE)
    .map((r) => ({
      id: r.tmdb_id,
      title: r.title,
      poster_path: r.poster_path,
      media_type: r.media_type,
      watchedAt: r.watched_at,
      season: r.season,
      episode: r.episode,
      episodeName: r.episode_name,
    }));
  const library = {};
  const libraryOrder = [];
  for (const r of db.prepare("SELECT * FROM library WHERE user_id = ? ORDER BY position").all(userId)) {
    const key = `${r.media_type}_${r.tmdb_id}`;
    library[key] = {
      id: r.tmdb_id,
      title: r.title,
      poster_path: r.poster_path,
      media_type: r.media_type,
      vote_average: r.vote_average,
      year: r.year,
    };
    libraryOrder.push(key);
  }
  const settings = {};
  for (const r of db.prepare("SELECT key, value_json FROM user_settings WHERE user_id = ?").all(userId)) {
    try { settings[r.key] = JSON.parse(r.value_json); } catch { /* skip corrupt row */ }
  }
  return { progress, watched, history, library, libraryOrder: libraryOrder.length ? libraryOrder : null, settings };
}

function upsertProgress(db, userId, mediaKey, pct) {
  db.prepare(
    `INSERT INTO watch_progress (user_id, media_key, pct, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (user_id, media_key) DO UPDATE SET pct = excluded.pct, updated_at = excluded.updated_at`,
  ).run(userId, String(mediaKey), pct, Date.now());
}

function setWatched(db, userId, mediaKey) {
  db.prepare("INSERT OR IGNORE INTO watched_titles (user_id, media_key, marked_at) VALUES (?,?,?)")
    .run(userId, String(mediaKey), Date.now());
}

function deleteWatched(db, userId, mediaKey) {
  db.prepare("DELETE FROM watched_titles WHERE user_id = ? AND media_key = ?").run(userId, String(mediaKey));
}

function addHistory(db, userId, entry) {
  const tmdb_id = Number(entry.id);
  const media_type = entry.media_type === "tv" ? "tv" : "movie";
  if (!Number.isInteger(tmdb_id)) {
    const err = new Error("bad history id");
    err.code = "BADKEY";
    throw err;
  }
  db.prepare(
    `INSERT INTO history (user_id, media_type, tmdb_id, title, poster_path, season, episode, episode_name, watched_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (user_id, media_type, tmdb_id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       season = excluded.season, episode = excluded.episode,
       episode_name = excluded.episode_name, watched_at = excluded.watched_at`,
  ).run(
    userId, media_type, tmdb_id,
    entry.title ?? null, entry.poster_path ?? null,
    entry.season ?? null, entry.episode ?? null, entry.episodeName ?? null,
    Number(entry.watchedAt) || Date.now(),
  );
  db.prepare(
    `DELETE FROM history WHERE rowid IN (
       SELECT rowid FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT -1 OFFSET ?
     )`,
  ).run(userId, HISTORY_CAP);
}

function clearHistory(db, userId) {
  db.prepare("DELETE FROM history WHERE user_id = ?").run(userId);
}

function nextLibraryPosition(db, userId) {
  const r = db.prepare("SELECT MAX(position) AS m FROM library WHERE user_id = ?").get(userId);
  return (r.m ?? -1) + 1;
}

function upsertLibraryItem(db, userId, key, item) {
  const { media_type, tmdb_id } = parseTitleKey(key);
  const existing = db
    .prepare("SELECT position FROM library WHERE user_id = ? AND media_type = ? AND tmdb_id = ?")
    .get(userId, media_type, tmdb_id);
  const position = existing ? existing.position : nextLibraryPosition(db, userId);
  db.prepare(
    `INSERT INTO library (user_id, media_type, tmdb_id, title, poster_path, vote_average, year, position, added_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (user_id, media_type, tmdb_id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       vote_average = excluded.vote_average, year = excluded.year`,
  ).run(
    userId, media_type, tmdb_id,
    (item && item.title) ?? null, (item && item.poster_path) ?? null,
    (item && item.vote_average) ?? null, (item && item.year) ?? null,
    position, Date.now(),
  );
}

function deleteLibraryItem(db, userId, key) {
  const { media_type, tmdb_id } = parseTitleKey(key);
  db.prepare("DELETE FROM library WHERE user_id = ? AND media_type = ? AND tmdb_id = ?")
    .run(userId, media_type, tmdb_id);
}

const setLibraryOrderTx = (db) =>
  db.transaction((userId, keys) => {
    const upd = db.prepare("UPDATE library SET position = ? WHERE user_id = ? AND media_type = ? AND tmdb_id = ?");
    keys.forEach((key, i) => {
      let parsed;
      try { parsed = parseTitleKey(key); } catch { return; } // unknown/bad keys ignored
      upd.run(i, userId, parsed.media_type, parsed.tmdb_id);
    });
  });

function setLibraryOrder(db, userId, keys) {
  setLibraryOrderTx(db)(userId, Array.isArray(keys) ? keys : []);
}

function setSettings(db, userId, obj) {
  const upsert = db.prepare(
    `INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(obj || {})) upsert.run(userId, k, JSON.stringify(v), Date.now());
  });
  tx();
}

// Merge rules (spec §API): progress/settings LWW (imported overwrites),
// watched/library union (never deletes server rows; new library keys appended
// in savedOrder order), history dedupe-by-title keeping the newer watchedAt.
function importState(db, userId, payload) {
  const p = payload || {};
  const tx = db.transaction(() => {
    for (const [key, pct] of Object.entries(p.progress || {})) {
      if (Number.isFinite(Number(pct))) upsertProgress(db, userId, key, Number(pct));
    }
    for (const key of Object.keys(p.watched || {})) setWatched(db, userId, key);
    for (const entry of Array.isArray(p.history) ? p.history : []) {
      const existing = db
        .prepare("SELECT watched_at FROM history WHERE user_id = ? AND media_type = ? AND tmdb_id = ?")
        .get(userId, entry.media_type === "tv" ? "tv" : "movie", Number(entry.id));
      if (!existing || Number(entry.watchedAt) > existing.watched_at) {
        try { addHistory(db, userId, entry); } catch { /* skip bad entries */ }
      }
    }
    const saved = p.saved || {};
    const orderedKeys = Array.isArray(p.savedOrder)
      ? [...p.savedOrder, ...Object.keys(saved).filter((k) => !p.savedOrder.includes(k))]
      : Object.keys(saved);
    for (const key of orderedKeys) {
      if (!saved[key]) continue;
      const exists = (() => {
        try {
          const { media_type, tmdb_id } = parseTitleKey(key);
          return !!db.prepare("SELECT 1 FROM library WHERE user_id = ? AND media_type = ? AND tmdb_id = ?").get(userId, media_type, tmdb_id);
        } catch { return true; } // bad key → skip below
      })();
      if (!exists) {
        try { upsertLibraryItem(db, userId, key, saved[key]); } catch { /* skip bad keys */ }
      }
    }
    setSettings(db, userId, p.settings || {});
  });
  tx();
  return getBootstrap(db, userId);
}

module.exports = {
  getBootstrap, upsertProgress, setWatched, deleteWatched,
  addHistory, clearHistory, upsertLibraryItem, deleteLibraryItem,
  setLibraryOrder, setSettings, importState, parseTitleKey,
  HISTORY_CAP, HISTORY_PAGE,
};
