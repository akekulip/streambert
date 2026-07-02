# Dedicated Admin Page — Design

Date: 2026-07-02
Status: approved (brainstorming session with Philip)

## Problem

Admin tooling (analytics dashboard, user management) currently lives as a
gated group at the bottom of the 3,900-line Settings page. Philip wants:

- admin surface on its own dedicated page, visible only to admin accounts,
- Settings back to user-only concerns,
- an overview of **all** user activity (watches, logins, searches, settings
  changes — full audit-style log),
- full control surface: existing controls plus disable/enable accounts,
  force logout (session revocation), and promote/demote admins.
- system-level settings (API tokens, download path) hidden from normal
  users — their Settings page affects only their own profile/experience
  (see §3a; this closes a real security gap where any user could overwrite
  the shared API tokens).

## Approach (chosen)

In-app admin page: a new admin-only sidebar entry opens a dedicated page
inside the existing SPA navigation (`page === "admin"`), with four tabs.
Rejected alternatives: a separate `/admin` mini-app (duplicates auth/build
plumbing for a single-admin household app) and a move-only first round
(doesn't deliver the requested activity log or controls).

## 1. Server — data model

- **New table `activity_events`**:
  `id INTEGER PK, user_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('login','search','settings')), detail TEXT, at TEXT NOT NULL`
  with indexes on `(at)` and `(user_id, at)`. `detail` is a small JSON blob
  per kind (see hooks below).
- **Watch events stay in `watch_events`** — analytics and the recs harvest
  depend on that table. The activity feed UNIONs `watch_events` (mapped to
  `kind = 'watch'`) with `activity_events` at query time, resolving titles
  from `history` via the same correlated-subquery pattern `analytics.js`
  already uses. One source of truth per event kind; no double-writes.
- **`users` gains two columns** via idempotent `ALTER TABLE` migration:
  - `disabled INTEGER NOT NULL DEFAULT 0`
  - `session_epoch INTEGER NOT NULL DEFAULT 0`
- **Cookie**: `sb_session` signed value changes from `"<id>"` to
  `"<id>.<epoch>"`. `resolveUser` rejects the session when the cookie epoch
  doesn't equal the user's current `session_epoch`, or when the account is
  disabled. A legacy `"<id>"` cookie (no dot) parses as epoch 0, so the
  deploy itself logs nobody out.

## 2. Server — capture hooks and admin API

Capture hooks (all fire-and-forget inserts; a failed log write must never
fail the user's request):

- **login** — `routes/auth.js` on successful login. `detail: null`.
- **search** — `routes/tmdb.js` proxy, when the proxied path starts with
  `search/` and carries a non-empty `query` param.
  `detail: {"query": "..."}`. Debounce: if the user's most recent search
  event is younger than 15 seconds, UPDATE that row's `detail` and `at`
  instead of inserting — a search-as-you-type burst collapses to the final
  query.
- **settings** — `routes/state.js` `PUT /settings`. Diff top-level keys of
  the incoming blob against the stored one; log
  `detail: {"keys": ["...changed keys..."]}`; skip the event entirely when
  nothing changed.

New/changed admin endpoints (`routes/admin.js`, all behind the existing
role gate):

- `GET /api/admin/activity?user=<id>&kind=<kind>&before=<cursor>&limit=<n>`
  — unified feed, newest first, cursor-paginated (default limit 50,
  max 200). Returns `{events: [{user_id, username, kind, detail, at,
  title?, media_type?, tmdb_id?, season?, episode?}], nextBefore}`.
- `PATCH /api/admin/users/:id` — body `{role?}` and/or `{disabled?}`.
  Setting `disabled: true` also bumps `session_epoch` so live sessions die
  immediately.
- `POST /api/admin/users/:id/revoke-sessions` — bumps `session_epoch`.
- `POST /api/admin/users/:id/reset-password` (existing) — now also bumps
  `session_epoch` (safe default: a reset kicks old sessions).
- **Guards**: the last remaining admin cannot be demoted, disabled, or
  deleted (extends the existing `deleteUser` last-admin guard). Applies to
  self-targeting too — a sole admin cannot lock themselves out.

## 3. Client

- **New `src/pages/AdminPage.jsx`** with four tabs:
  - **Overview** — the existing analytics dashboard (stat tiles, activity
    bars, type split, top titles, most active users).
  - **Activity** — new unified feed: one row per event ("kofi searched
    \"dune\"", "ama watched Severance S2E4", "nana changed settings:
    playback"), filter dropdowns for user and kind, load-more pagination
    via the `before` cursor.
  - **Users** — the existing `UsersAdminPanel` extended with: role select
    (promote/demote), enable/disable toggle, revoke-sessions button.
  - **System** — extraction canary status + "Run check now", recs-cache
    purge (moved out of `AdminDashboard` so Overview stays analytics-only),
    and the **system-level settings** moved out of the normal Settings page
    (see §3a).
- **Sidebar** (`src/components/Sidebar.jsx`): shield icon between Downloads
  and Settings, rendered only when `me?.role === "admin"`, navigating to
  the new `page === "admin"` route in `App.jsx`.
- **App.jsx**: add the `admin` page branch; defensively redirect non-admins
  to home if they somehow land on it (the server remains the real gate).
- **SettingsPage.jsx**: delete the ADMIN group and the
  `AdminDashboard`/`UsersAdminPanel` imports — Settings is user-only again.

## 3a. Settings scope split (system vs. per-user)

Motivation: normal users must not see or edit deployment-wide settings —
their Settings page should only affect their own profile and experience.
Today `server/routes/secure.js` is a **single global `secure.json` with no
role gate**, so any logged-in user can read *and overwrite* the shared TMDB
/ SubDL / Wyzie tokens for the whole deployment. This is a security gap, not
just a UI-tidiness issue.

**System-level → move to Admin page "System" tab, admin-only:**

- TMDB Read Access Token (`apikey`)
- SubDL API key (`subdlApiKey`), Wyzie API key (`wyzieApiKey`)
- Download path (`downloadPath`) — a server disk location
- Update settings (auto-check) — deployment/desktop concern
- (App version display is harmless and can stay visible to everyone.)

**Per-user → stays in Settings:**

- Content: parental controls / age rating
- Playback: trailer source, auto-watched behavior
- Subtitles: **preferred language only** (the API key moves — this group
  gets split)
- Notifications, Interface (appearance/layout/start page), Library
  (sort/history), Backup & Restore (their own data)

**Server enforcement (the actual fix):** gate `PUT /api/secure/:key` behind
`req.user.role === "admin"` so a normal user can't overwrite shared secrets.
`GET` needs a decision during planning: if any client path for a normal user
reads a secret to function, keep read open but return a masked/boolean
"is set" instead of the raw value; otherwise gate reads too. In the web
build TMDB already flows through the server proxy (`fastify.tmdbFetch` with
the env token), so the client likely does not need the raw `apikey` — verify
before gating reads.

**Out of scope here:** admin-*enforced* per-user policy (e.g. locking a
child account's parental controls) — that's a separate feature.

- Server tests (node test suites under `server/test/`):
  - activity capture for all three hooks, incl. search debounce collapse
    and settings no-op skip;
  - unified feed ordering, user/kind filters, cursor pagination, title
    resolution for watch rows;
  - disabled account: blocked at login AND existing session rejected;
  - epoch revocation (revoke endpoint, disable, password reset);
  - role PATCH incl. last-admin guards;
  - legacy `"<id>"` cookie still resolves (epoch-0 compat);
  - `PUT /api/secure/:key` rejected (403) for a normal user, allowed for
    an admin (§3a enforcement).
- Client: manual verification via the web dev build (admin sees the shield
  + page; non-admin sees neither; Settings shows no admin group).
- Deploy: rebuild the prod image and redeploy on the Vision host as usual —
  **only when Philip says go**.

## Out of scope

- Tracking beyond the four event kinds (no page-view or player telemetry).
- Retention/pruning policy for `activity_events` (revisit if the table
  grows past what SQLite handles comfortably — not a concern at household
  scale).
- Admin notification/alerting on events.
