# Self-Registration + Admin Approval — Design

Date: 2026-07-02
Status: approved (interactive Q&A with Philip)

## Problem

The app is going public at `xtreamz.org` (Cloudflare Tunnel). Instead of the
admin hand-creating every account, users should **self-register**, but no one
should be able to watch until the **admin approves** them. New signups sit in a
**pending** state; the admin sees them in-app and activates them.

## Confirmed requirements

- **Sign up** with an **email or phone number** + **password** (no username).
  **No verification** — no email/SMS code, no 2FA. Admin approval is the only gate.
- New accounts are created **pending** (can't watch anything).
- A pending user **can log in** but every screen shows **"awaiting approval"**,
  including **WhatsApp and Telegram links to contact the admin** to request
  activation.
- Admin sees a **"Pending approval" list with a count badge** in the admin
  panel, and **Activate** (or reject/delete) each one.
- After activation the user can watch normally.
- Existing admin/user accounts keep working unchanged (treated as active).

## 1. Data model

Add one column to `users` (idempotent `ALTER TABLE`, migration in `db.js`):

```
status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','disabled'))
```

- Existing rows default to **`active`** (already-approved), so nothing breaks.
- Self-registrations insert **`pending`**.
- Admin **activate** → `active`; **suspend** → `disabled`; **reject** → delete.
- This unifies "pending approval" and "suspended" into one field; it supersedes
  the separate `disabled` flag sketched in the admin-page spec (align that later).

The **email/phone is stored as `username`** (the existing unique login
identifier) — no new identity columns. The `username UNIQUE COLLATE NOCASE`
constraint already prevents duplicate signups. `role` stays `user` for all
self-registrations.

## 2. Server — registration + gating

**`server/lib/users.js`**
- `registerUser(db, { identifier, password })`: validate, then
  `insertUser({ username: identifier, password, role: 'user' })` with
  `status: 'pending'`. Extend `insertUser` to accept `status` (default
  `'active'` so admin-created and bootstrap accounts stay active).
- Validation helpers (pure, unit-tested):
  - `isValidIdentifier(s)`: a plausible **email** (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`)
    **or phone** (`/^\+?[0-9][0-9\s-]{6,}$/` after trimming).
  - `isValidPassword(s)`: length ≥ 8.
- `listUsers`, `getUserByUsername`, `getUserById` SELECTs add `status`.
- New: `setUserStatus(db, id, status)`.

**Public config for contact links — `server/routes/meta.js` (or auth):**
- `GET /api/config` (OPEN, unauthenticated): returns
  `{ whatsapp, telegram }` — the admin contact links for the pending screen,
  read from env (`STREAMBERT_ADMIN_WHATSAPP`, `STREAMBERT_ADMIN_TELEGRAM`).
  Normalize: a value starting with `http` is used as-is; otherwise WhatsApp →
  `https://wa.me/<digits-only>` and Telegram → `https://t.me/<handle-without-@>`.
  Unset → `null` (client hides that link). No other secrets are exposed here.

**`server/routes/auth.js`**
- `POST /api/register` (OPEN, unauthenticated, rate-limited by `loginThrottle`
  keyed on IP): body `{ identifier, password }`. Returns `400` for invalid
  input, `409` if the identifier is taken, else creates a **pending** user and
  returns `{ ok: true, status: 'pending' }`. Never logs the user in.
- `GET /api/me` returns `{ id, username, role, status }` (adds `status`).
- Login is unchanged — a pending/disabled user with the right password still
  gets a session; the app gates them by `status`.

**Access gate (defense in depth) — `server/app.js` preHandler:**
After resolving `req.user` for `/api/*`, if the user is authenticated but
`status !== 'active'`, reject with `403 {error:'account not active', status}`
for everything **except** the always-allowed set `[/api/me, /api/logout]`. This
blocks a pending user from hitting content/state/stream APIs directly.
Also gate **`/vzy`** (currently an open proxy) behind auth + active — folds in
the pre-launch "don't expose an open proxy" hardening.

## 3. Server — admin approval

**`server/routes/admin.js`** (all behind the existing admin role gate):
- `GET /api/admin/users` already lists users; now includes `status`. The client
  derives the pending list + count from it (no new endpoint needed).
- `POST /api/admin/users/:id/activate` → `setUserStatus(id,'active')`.
- `POST /api/admin/users/:id/suspend` → `setUserStatus(id,'disabled')`.
- Reject = existing `DELETE /api/admin/users/:id`.
- Guard: a `POST /api/admin/users` (admin-created) defaults to `status:'active'`.

## 4. Client

- **`LoginGate.jsx`**: add a **"Create account"** toggle → a form with one
  "Email or phone number" field, password, confirm password. Submits to
  `/api/register`; on success shows **"Account created — an admin will approve
  it shortly."** Inline validation mirrors the server rules.
- **`App.jsx`**: after login, if `me.status !== 'active'`, render a full-screen
  **PendingScreen** ("Your account is awaiting approval" / for `disabled`,
  "Your account has been suspended") with a Log out button — instead of the app.
  PendingScreen fetches `GET /api/config` and shows **WhatsApp** and **Telegram**
  contact buttons (each hidden if its link is null) so the user can message the
  admin to get approved.
- **Admin surface** (`UsersAdminPanel.jsx`): a **"Pending approval"** section at
  the top listing `status==='pending'` users with **Activate** and **Reject**
  buttons, and a **count badge** on the Admin entry. Active/suspended users list
  as today with an Activate/Suspend toggle.

## 5. Testing

- Server unit (node:test): `isValidIdentifier` (email + phone accept/reject),
  `isValidPassword`; `registerUser` inserts `pending`; duplicate → 409;
  `setUserStatus`; the preHandler 403s a pending user on a content route but
  allows `/api/me` + `/api/logout`; admin activate flips to `active`.
- Client: manual web pass — register → pending screen → admin sees it in the
  pending list with badge → activate → user can watch; suspend → pending screen
  again.

## Out of scope

- Email/SMS delivery or verification (explicitly not wanted).
- Password reset self-service (admin reset already exists).
- The full dedicated admin *page* (separate spec) — this adds the pending list
  to the existing admin surface; it migrates into that page when built.
