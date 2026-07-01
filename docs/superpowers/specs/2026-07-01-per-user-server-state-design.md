# Per-User Server State (Phase 2) — Design

_2026-07-01. Branch: `web-port`. Approved via brainstorming session._

## Goal

Move the five user-state domains — watch progress, watched marks, history, library
(+ order), and user settings — from browser `localStorage` into SQLite keyed by
`user_id`, with cross-device sync and a one-time migration of existing local data.

This completes the handoff's unstarted "Phase 2 (per-user server state)" and is the
foundation for the follow-on sub-projects: server-side recommendations, analytics,
and the admin dashboard — all of which need queryable per-user content state.

**Scale target:** small community, ~10–100 users, single Fastify process + SQLite
(WAL). No Postgres, no horizontal scaling.

**Out of scope:** per-user downloads (Phase 3), analytics event ingestion,
recommendation engine changes, profiles/avatars, per-user secure keys
(`secure.json` stays instance-level).

## Architecture decision

Hybrid (chosen over pure key-value blobs and over fully-normalized-everything):

- **Normalized tables** for the four *content* domains (progress, watched, history,
  library) — exactly the data recommendations/analytics must query, and fine-grained
  upserts avoid rewriting a growing blob on every progress tick.
- **Generic KV table** for *settings* — opaque preferences nobody will query.

## Schema (`server/lib/db.js`, additive `CREATE TABLE IF NOT EXISTS`)

```sql
CREATE TABLE IF NOT EXISTS watch_progress (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_key  TEXT    NOT NULL,   -- "movie_123" | "tv_456_s1e2" (existing format)
  pct        REAL    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_key)
);

CREATE TABLE IF NOT EXISTS watched_titles (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_key  TEXT    NOT NULL,
  marked_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_key)
);

CREATE TABLE IF NOT EXISTS history (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type   TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id      INTEGER NOT NULL,
  title        TEXT,
  poster_path  TEXT,
  season       INTEGER,           -- NULL for movies
  episode      INTEGER,
  episode_name TEXT,
  watched_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_type, tmdb_id)   -- one row per title, like today
);

CREATE TABLE IF NOT EXISTS library (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type   TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
  tmdb_id      INTEGER NOT NULL,
  title        TEXT,
  poster_path  TEXT,
  vote_average REAL,
  year         TEXT,
  position     INTEGER NOT NULL,  -- replaces localStorage savedOrder
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_type, tmdb_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value_json TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
```

- `history` capped server-side at **500 rows/user** (oldest evicted on insert);
  bootstrap returns the newest **50** to match current UI semantics.
- `foreign_keys = ON` is already set in `openDb`; cascade covers user deletion.

## API (`server/routes/state.js`, prefix `/api/state`)

All routes are behind the existing global session gate (`req.user` set by the
`preHandler` in `server/app.js`). Every query is scoped by `req.user.id`.

| Route | Behavior |
|---|---|
| `GET /bootstrap` | `{ progress, watched, history, library, libraryOrder, settings }` — single hydration payload. Shapes mirror the localStorage shapes the frontend already uses. |
| `PUT /progress/:key` | body `{pct}`; upsert with `updated_at = now`. |
| `POST /progress/beacon` | same as PUT but `navigator.sendBeacon`-compatible (plain POST body `{key, pct}`; no custom headers needed; cookie auth applies). |
| `PUT /watched/:key` / `DELETE /watched/:key` | mark / unmark. |
| `POST /history` | body = history entry (id, media_type, title, poster_path, season, episode, episodeName, watchedAt); upsert by (media_type, tmdb_id); evict beyond 500. |
| `DELETE /history` | clear the user's history. |
| `PUT /library/:key` | body = saved item; append with `position = max+1`. |
| `DELETE /library/:key` | remove. |
| `PUT /library/order` | body `{keys: []}`; transactional rewrite of `position` for all rows. |
| `PUT /settings` | body `{key: value, ...}` bulk JSON upsert. |
| `POST /import` | full localStorage-shaped payload; used by one-time migration AND offline-write reconcile. Merge rules below. |

**Merge rules (`/import`, implemented in `server/lib/userState.js`):**

- `progress`, `settings`: last-write-wins per key (imported value overwrites).
- `watched`, `library`: union (imported entries upserted; never deletes server rows).
  Imported library keys not on the server are appended to the end of the order.
- `history`: dedupe by (media_type, tmdb_id), keeping the entry with newer `watchedAt`.

**Rate limiting:** simple per-user token bucket on `/api/state` writes,
~120 writes/min (progress is client-throttled to 1 write per key per 10 s, so an
active playback session uses ~6/min). Follows the `loginThrottle` module pattern.

## Client integration

New module `src/utils/userState.js`:

- `hydrate()` — called after login/app start: `GET /bootstrap`, returns the five
  domains; on network failure returns `null` (caller falls back to localStorage).
- Per-domain write functions (`saveProgress`, `markWatched`, `unmarkWatched`,
  `addHistory`, `clearHistory`, `saveLibraryItem`, `removeLibraryItem`,
  `saveLibraryOrder`, `saveSettings`) — each writes localStorage first (instant
  paint cache + offline fallback), then the server.
- Progress: throttle to one `PUT` per key per 10 s; flush pending value on
  pause/unload via `sendBeacon`.
- Failure handling: on any failed write, set a per-domain dirty flag
  (localStorage); on next `window` focus or `online` event, re-push dirty domains
  through `POST /import` (idempotent by merge rules), then clear flags.

**App.jsx changes are surgical:** the existing handlers (`toggleSave`,
`addHistory`, `saveProgress`, `markWatched`, `markUnwatched`,
`handleReorderSaved`, history-clear in Settings) swap their `storage.set(...)`
lines for the matching `userState.*` call. State shapes and prop drilling stay
unchanged. Hydration order on start: paint from localStorage → bootstrap →
`setProgress/setHistory/setWatched/setSaved/setSavedOrder` with server truth.

**Settings split.** Synced (user-level): `PLAYER_SOURCE`, `ALLMANGA_DUB_MODE`,
`START_PAGE`, `AGE_LIMIT`, `RATING_COUNTRY`, `WATCHED_THRESHOLD`,
`AUTOPLAY_NEXT_*`, `HOME_ROW_ORDER`, `HOME_ROW_VISIBLE`, `HOME_VIEW_MODE`,
`SUBTITLE_ENABLED`, `SUBTITLE_LANG`, `INTRO_SKIP_MODE`, `LIBRARY_SORT`,
`HISTORY_ENABLED`, `ACCENT_COLOR`, `INVIDIOUS_BASE`, `browseFilters`.
Device-local (NOT synced): `FONT_SIZE`, `COMPACT_MODE`, `REDUCE_ANIMATIONS`,
`DL_*`, download paths, and all caches (`trendingCache`, `EPISODE_RELEASE_CACHE`,
`SOURCE_FAILOVER_CACHE`, AniList/EpisodeGroup caches).

**Cross-user safety on shared browsers:** the login/session response identifies
the user id; `userState` records `streambert_lastUserId`. If a different user
logs in, the local caches for the five state domains are cleared **before**
hydration, so user B never sees or imports user A's data.

## Migration (one-time, automatic)

After login: if `GET /bootstrap` returns all four content domains empty AND
localStorage has data → `POST /import` once, guarded by a per-user local flag
(`streambert_migrated_<userId>`). Union-merge rules make a second device
importing later safe. No user prompt.

## Live multi-device sync

`server/events.js` gains a `ws → userId` map (resolved from the session cookie at
connect time) and `fastify.broadcastToUser(userId, channel, payload)`. State
routes emit `state-changed {domain}` to the user's *other* sessions (excluding
the originating one is best-effort; refetch is idempotent). The client refetches
that domain on receipt.

_Known pre-existing issue, out of scope but now trivially fixable: the hub
broadcasts download progress to ALL logged-in clients; Phase 3 should switch it
to `broadcastToUser`._

## Error handling & offline

- Server unreachable → app runs from localStorage cache exactly as today.
- Bootstrap failure → silent fallback to cache; retry on next focus.
- Beacon/throttled writes are fire-and-forget; the dirty-flag + `/import`
  reconcile path guarantees eventual convergence.

## Testing

- `node --test server/test/state.test.js`: bootstrap round-trip; per-route
  upserts/deletes; import merge rules (LWW, union, history dedupe); history cap
  eviction; library order rewrite; **user isolation** (A cannot read/write B);
  rate limit returns 429; unauthenticated → 401.
- `node --test server/test/userStateLib.test.js`: pure merge helpers.
- Frontend: `npm run build` green; manual two-browser (two-user) session check
  before deploy; verify migration by seeding localStorage and logging in fresh.

## Deploy notes

Standard app-container rebuild per `docs/HANDOFF.md` §2 (schema is additive; no
data-dir changes). The SQLite daily backup already covers the new tables.
