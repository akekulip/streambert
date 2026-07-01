# Multi-User Accounts — Phase 1: Accounts & Auth Foundation

- **Date:** 2026-07-01
- **Status:** Approved design (pre-implementation)
- **Scope:** Web port (`server/` + `src/`) only. The Electron desktop build is unaffected.

## 1. Context

The web port is currently **single-user**. Authentication is one shared password
(`STREAMBERT_PASSWORD`) exchanged for a signed HTTP-only cookie
(`server/index.js`). There is no concept of a user account. Per-user-ish data
lives in two places:

- **Browser `localStorage`** (`src/utils/storage.js`) — watch progress, history,
  saved/library, watched, and all settings (appearance, subtitles, home layout,
  age limit, notifications, etc.). Per-browser, not per-account.
- **Shared server files** under `DATA_DIR` — `secure.json` (TMDB/SubDL/Wyzie
  keys) and `downloads.json` (the single shared download registry; media files on
  disk). The TMDB token is now operator-level via `.env`
  (`STREAMBERT_TMDB_TOKEN`).

## 2. Overall goal & phase decomposition

**Goal:** multiple users log in to their own accounts; their profile,
preferences, and state are saved server-side and follow them across devices.

**Confirmed decisions:**
- Accounts are **admin-created** (no open self-registration).
- **Everything is per-user**, including downloads (eventually).
- Per-user state is **server-side** and follows the user across devices.
- Storage backend is **SQLite** (`better-sqlite3`).

Because this touches auth, the entire client storage layer, and the downloader,
it is delivered in three independently shippable phases. **This spec covers
Phase 1 only.**

| Phase | Scope |
|------|-------|
| **1 (this spec)** | Accounts & auth foundation: user store, username+password login, per-user sessions, admin user management. |
| 2 (future) | Server-side per-user state: move progress/history/saved/watched/settings/subtitle-keys from localStorage to a per-user server store + API. |
| 3 (future) | Per-user downloads: per-user download directories + ownership; scope `/api/downloads` and `/api/files` to the session user. |

### Phase 1 non-goals (explicitly deferred)
- Per-user state migration — state **stays in `localStorage`** this phase.
- Per-user downloads/secure store — `downloads.json` and `secure.json` remain
  **shared** this phase.
- Open self-registration, invite flows, email/password reset, MFA.
- Self-service password change (a user changing their own password) — deferred;
  in Phase 1 an admin resets passwords via the Users panel.

## 3. Design

### 3.1 Data model

- Add dependency **`better-sqlite3`** to `server/package.json`.
- Database file: `DATA_DIR/streambert.db` (persists on the existing `/data`
  volume mount).
- A single new module `server/lib/db.js` opens the DB, runs migrations (a
  `schema_version` pragma/table), and exposes typed helpers. Phase-1 schema:

  ```sql
  CREATE TABLE users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash    TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    created_at INTEGER NOT NULL
  );
  ```

- **Password hashing:** Node's built-in `crypto.scryptSync(password, salt, 64, {N:16384})`;
  per-user random 16-byte salt (hex). Verification via `crypto.timingSafeEqual`.
  No external crypto dependency. Hash/salt stored as hex strings.

### 3.2 Auth flow

- `POST /api/login {username, password}`:
  - Look up user by username (case-insensitive). Verify with scrypt +
    `timingSafeEqual`.
  - On success set a **signed HTTP-only cookie** `sb_session` whose value is the
    user id, using the existing `@fastify/cookie` `signCookie`. No server-side
    session table (stateless signed cookie).
  - Cookie flags: `httpOnly`, `sameSite=lax`, `path=/`, `secure` when
    `x-forwarded-proto === https`, `maxAge` 30 days.
- **Per-request auth hook** (replaces `sessionValid`): unsign `sb_session` → get
  user id → `SELECT` the user from the DB. If the row is missing (e.g., deleted),
  treat as unauthenticated (instant revocation). Attach `req.user = {id, username, role}`.
- Open (no-auth) paths stay: `/api/login`, `/api/logout`, `/api/events` (the WS
  hub validates the cookie itself).
- `POST /api/logout` clears the cookie. `GET /api/me` → `{username, role}`.
- The single shared-password gate in `server/index.js` is **removed**; login now
  requires a username.

### 3.3 Admin bootstrap & user management

- **First-run bootstrap** (in `db.js` init): if `users` is empty, create one
  `admin`:
  1. If `STREAMBERT_ADMIN_USER` and `STREAMBERT_ADMIN_PASSWORD` are set, use them.
  2. Else fall back to username `admin` with the existing `STREAMBERT_PASSWORD`
     value, so the current Vision deployment keeps working (log in as `admin`
     with today's password). Log a one-line notice that this fallback was used.
- **Admin API** (`server/routes/admin.js`, prefix `/api/admin`, all guarded by a
  `requireAdmin` check that returns 403 for non-admins):
  - `GET /api/admin/users` → `[{id, username, role, created_at}]` (never hashes).
  - `POST /api/admin/users {username, password, role}` → create (409 on
    duplicate username, 400 on weak input).
  - `POST /api/admin/users/:id/reset-password {password}` → set new hash.
  - `DELETE /api/admin/users/:id` → delete (guard: cannot delete the last
    remaining admin).
- **Admin-only "Users" panel** in `src/pages/SettingsPage.jsx`: list users; add
  user (username + initial password); reset password; delete. Hidden unless
  `me.role === 'admin'`.

### 3.4 Frontend changes

- `src/components/LoginGate.jsx`: two fields (username + password); `POST
  /api/login {username, password}`; reload on success (existing pattern).
- App fetches `GET /api/me` after auth to obtain `{username, role}`; stored in
  app state and used to gate the admin Users panel. A tiny `src/utils/session.js`
  helper wraps `/api/me`, `/api/login`, `/api/logout`.
- No other app behavior changes in Phase 1 (state still flows through
  `localStorage`).

### 3.5 Security

- Generic failure message "Invalid username or password" (no user enumeration;
  same timing path for missing user vs bad password).
- **Login throttle:** in-memory counter keyed by `username+client-IP`; after N
  (default 5) failures in a rolling window, respond 429 with a short lockout
  (e.g., 60s). Best-effort, single-process; documented as such.
- Minimum password length (e.g., 8) enforced on create/reset.
- `scrypt N=16384`; cookie flags as in 3.2; `COOKIE_SECRET` unchanged.

### 3.6 Migration & backward compatibility

- Existing signed cookies become invalid on deploy (value is now a user id, not
  `"ok"`), so everyone logs in once. Acceptable and expected.
- No data migration in Phase 1: `localStorage` state, `secure.json`, and
  `downloads.json` are untouched and remain shared/per-browser as today.
- `STREAMBERT_PASSWORD` is retained **only** as the admin-bootstrap fallback and
  documented as deprecated for direct login.
- Docs updated: `docs/DEPLOY.md` env table gains `STREAMBERT_ADMIN_USER` /
  `STREAMBERT_ADMIN_PASSWORD` (optional; bootstrap only) and notes the login
  change; `.env.example` updated.

### 3.7 Build / deploy considerations

- `better-sqlite3` ships prebuilt binaries for linux x64/node 20; expected to
  install without a toolchain in `node:20-slim`. Verify the image builds; if the
  prebuilt is unavailable, add `python3`/`make`/`g++` to the builder stage only.
- DB file lives under the mounted `/data` volume, so it persists across
  container recreates (same mechanism already used for `secure.json`).

## 4. API surface (Phase 1)

| Method | Path | Auth | Purpose |
|-------|------|------|---------|
| POST | `/api/login` | open | username+password → session cookie |
| POST | `/api/logout` | open | clear cookie |
| GET | `/api/me` | user | current `{username, role}` |
| GET | `/api/admin/users` | admin | list users |
| POST | `/api/admin/users` | admin | create user |
| POST | `/api/admin/users/:id/reset-password` | admin | reset password |
| DELETE | `/api/admin/users/:id` | admin | delete user (not last admin) |

## 5. Testing strategy

- **Unit:** scrypt hash/verify round-trip + wrong-password rejection; cookie
  sign/unsign; `requireAdmin` allows admin / 403s user; last-admin-delete guard;
  duplicate-username rejection.
- **Integration** (Fastify `inject`): login success/failure; `/api/me` reflects
  the session; admin CRUD happy paths; non-admin gets 403 on `/api/admin/*`;
  deleted user's cookie is rejected on next request; login throttle returns 429
  after N failures.
- **Manual/smoke on Vision:** rebuild image, recreate container (rollback kept),
  confirm bootstrap admin login works with the current password, create a second
  user, log in as that user, confirm non-admin cannot see/hit admin endpoints.

## 6. Success criteria

- Admin logs in with username+password; the shared-password-only gate is gone.
- Admin can create, reset, and delete users from the Settings Users panel.
- A non-admin user can log in and use the app; admin endpoints/UI are inaccessible.
- Deleting a user immediately invalidates their session.
- Existing Vision deployment upgrades cleanly: `admin` + current password works
  with no manual DB steps; downloads and the app otherwise behave as before.
- The `node:20` Docker image builds with `better-sqlite3`.

## 7. Future phases (context, not in scope)

- **Phase 2:** per-user state store + API; refactor `storage.js`/`secureStorage`
  to read/write the server keyed by the session user; one-time import of the
  admin's existing browser state optional.
- **Phase 3:** per-user download directories + ownership on `downloads.json`/the
  downloader; scope `/api/downloads` and `/api/files` to `req.user`.
