# Self-Registration + Admin Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users self-register (email or phone + password) into a pending state; the admin approves them in-app before they can watch; the pending screen shows WhatsApp/Telegram links to reach the admin.

**Architecture:** Add a `users.status` column (`pending|active|disabled`). A public `POST /api/register` creates pending users; the `/api/*` + `/vzy` auth preHandler 403s any non-active user (except `/api/me` + `/api/logout`); admin endpoints flip status. Client gains a register form, a full-screen PendingScreen (with contact links from a public `/api/config`), and a pending-approval list in the admin panel.

**Tech Stack:** Fastify + better-sqlite3 + `node:test` (server); React (Vite ESM) verified by `vite build` + manual (no React test runner).

## Global Constraints

- **Node toolchain:** default `node` is v10 and cannot run tests/builds. Prefix every command with `export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"`.
- **Server tests:** CommonJS `node:test`, run from `server/`: `node --test test/`. Integration tests use `buildApp` + `app.inject` (see `server/test/auth.test.js`).
- **Client:** no React test runner — verify with `npm run build`; correctness by manual pass (Task 9).
- **Status values:** exactly `'pending' | 'active' | 'disabled'`. Existing rows migrate to `'active'`. Self-registrations are `'pending'`. Enforced in code (the ALTER-added column has no CHECK — SQLite limitation).
- **Identifier = the `username` column** (holds email or phone); `username UNIQUE COLLATE NOCASE` already prevents duplicates. All self-registrations are `role: 'user'`.
- **Password rule:** length ≥ 8 (matches existing `createUser`).
- **No verification:** no email/SMS/OTP/2FA. Admin approval is the only gate.
- **Contact links** from env `STREAMBERT_ADMIN_WHATSAPP`, `STREAMBERT_ADMIN_TELEGRAM`; unset → `null`.
- **Commits:** Conventional Commits; end body with the repo's `Co-Authored-By: Claude Fable 5` + `Claude-Session` trailers.

---

## File Structure

- `server/lib/db.js` — migration: add `users.status`.
- `server/lib/users.js` — `isValidIdentifier`, `isValidPassword`, `insertUser(status)`, `registerUser`, `setUserStatus`, `listUsers`/`getUserByUsername` include `status`.
- `server/routes/auth.js` — `POST /api/register`; `/api/me` returns `status`.
- `server/routes/meta.js` — `GET /api/config` (contact links).
- `server/app.js` — `resolveUser` includes `status`; `OPEN` += register/config; status-gate preHandler; gate `/vzy`.
- `server/routes/admin.js` — activate/suspend endpoints.
- `src/components/LoginGate.jsx` — register form.
- `src/components/PendingScreen.jsx` (new) + `src/App.jsx` — pending gate.
- `src/components/UsersAdminPanel.jsx` — pending list + badge + activate/reject.

---

## Task 1: DB migration — `users.status`

**Files:** Modify `server/lib/db.js` (`migrate`); Test `server/test/db.test.js` (add cases).

**Interfaces:** Produces: `users` rows have `status TEXT NOT NULL DEFAULT 'active'`.

- [ ] **Step 1: Write the failing test** — append to `server/test/db.test.js`:
```js
const { test } = require("node:test");
const assert = require("node:assert");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");

test("users.status column exists and defaults to active", () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "u1@example.com", password: "password1" });
  const row = db.prepare("SELECT status FROM users WHERE username = 'u1@example.com' COLLATE NOCASE").get();
  assert.equal(row.status, "active");
  // idempotent: migrate again (re-open same handle path is n/a for :memory:, so
  // just assert the PRAGMA shows exactly one status column)
  const cols = db.prepare("PRAGMA table_info(users)").all().filter((c) => c.name === "status");
  assert.equal(cols.length, 1);
});
```

- [ ] **Step 2: Run to verify it fails**
```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
cd server && node --test test/db.test.js
```
Expected: FAIL — `no such column: status`.

- [ ] **Step 3: Implement** — in `server/lib/db.js`, inside `migrate(db)`, **after** the big `db.exec(\`...\`)` CREATE block and before the watch_events seed, add:
```js
  // Registration/approval: add users.status if missing (existing rows -> active).
  // ALTER-added column omits CHECK (SQLite can't always add a CHECK column);
  // valid values ('pending'|'active'|'disabled') are enforced in lib/users.js.
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  if (!userCols.some((c) => c.name === "status")) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
```

- [ ] **Step 4: Run to verify it passes**
```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
cd server && node --test test/db.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/db.js server/test/db.test.js
git commit -m "feat(auth): add users.status column (pending/active/disabled)"
```

---

## Task 2: Validation helpers

**Files:** Modify `server/lib/users.js`; Test `server/test/register.test.js` (new).

**Interfaces:** Produces: `isValidIdentifier(s)->bool`, `isValidPassword(s)->bool` (exported).

- [ ] **Step 1: Write the failing test** — `server/test/register.test.js`:
```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isValidIdentifier, isValidPassword } = require("../lib/users");

test("isValidIdentifier accepts emails and phones, rejects junk", () => {
  assert.equal(isValidIdentifier("a@b.co"), true);
  assert.equal(isValidIdentifier("+1 234-567-8901"), true);
  assert.equal(isValidIdentifier("5551234567"), true);
  assert.equal(isValidIdentifier("notanemail"), false);
  assert.equal(isValidIdentifier("12345"), false); // too short for a phone
  assert.equal(isValidIdentifier(""), false);
});
test("isValidPassword requires >= 8 chars", () => {
  assert.equal(isValidPassword("password1"), true);
  assert.equal(isValidPassword("short"), false);
  assert.equal(isValidPassword(""), false);
});
```

- [ ] **Step 2: Run to verify it fails**
```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
cd server && node --test test/register.test.js
```
Expected: FAIL — `isValidIdentifier is not a function`.

- [ ] **Step 3: Implement** — in `server/lib/users.js`, add near the top (after the require) and export them:
```js
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function isValidIdentifier(s) {
  const v = String(s || "").trim();
  if (EMAIL_RE.test(v)) return true;
  const digits = v.replace(/[^0-9]/g, "");
  return /^\+?[0-9][0-9\s-]*$/.test(v) && digits.length >= 7; // plausible phone
}
function isValidPassword(s) {
  return String(s || "").length >= 8;
}
```
Add `isValidIdentifier, isValidPassword` to `module.exports`.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/users.js server/test/register.test.js
git commit -m "feat(auth): identifier/password validation helpers"
```

---

## Task 3: users.js — status-aware inserts, register, setUserStatus, listUsers

**Files:** Modify `server/lib/users.js`; Test `server/test/register.test.js` (add).

**Interfaces:**
- Consumes: `isValidIdentifier`, `isValidPassword` (Task 2).
- Produces: `insertUser(db,{username,password,role,status})` (status default `'active'`); `registerUser(db,{identifier,password})->{id,username,status:'pending'}` (throws `{code:'BADINPUT'|'DUP'}`); `setUserStatus(db,id,status)`; `listUsers` rows include `status`.

- [ ] **Step 1: Write the failing test** — append to `server/test/register.test.js`:
```js
const { openDb } = require("../lib/db");
const { registerUser, setUserStatus, listUsers, getUserByUsername } = require("../lib/users");

test("registerUser creates a pending user", () => {
  const db = openDb(":memory:");
  const u = registerUser(db, { identifier: "new@user.com", password: "password1" });
  assert.equal(u.status, "pending");
  assert.equal(getUserByUsername(db, "new@user.com").status, "pending");
});
test("registerUser rejects bad input and duplicates", () => {
  const db = openDb(":memory:");
  assert.throws(() => registerUser(db, { identifier: "bad", password: "password1" }), /BADINPUT|invalid/i);
  assert.throws(() => registerUser(db, { identifier: "a@b.co", password: "short" }), /BADINPUT|invalid/i);
  registerUser(db, { identifier: "a@b.co", password: "password1" });
  assert.throws(() => registerUser(db, { identifier: "A@B.CO", password: "password1" }), (e) => e.code === "DUP");
});
test("setUserStatus flips status; listUsers exposes it", () => {
  const db = openDb(":memory:");
  const u = registerUser(db, { identifier: "c@d.com", password: "password1" });
  setUserStatus(db, u.id, "active");
  assert.equal(getUserByUsername(db, "c@d.com").status, "active");
  assert.ok(listUsers(db).every((r) => "status" in r));
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && node --test test/register.test.js`. Expected: FAIL (`registerUser is not a function`).

- [ ] **Step 3: Implement** — in `server/lib/users.js`:

Change `insertUser` to accept and store `status`:
```js
function insertUser(db, { username, password, role = "user", status = "active" }) {
  const uname = String(username || "").trim();
  const { hash, salt } = hashPassword(password);
  const created_at = Date.now();
  let info;
  try {
    info = db
      .prepare("INSERT INTO users (username, pw_hash, pw_salt, role, status, created_at) VALUES (?,?,?,?,?,?)")
      .run(uname, hash, salt, role, status, created_at);
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || String(e.message).includes("UNIQUE")) {
      const err = new Error("username taken");
      err.code = "DUP";
      throw err;
    }
    throw e;
  }
  return { id: info.lastInsertRowid, username: uname, role, status, created_at };
}
```

Add `registerUser` and `setUserStatus`:
```js
const VALID_STATUS = ["pending", "active", "disabled"];
function registerUser(db, { identifier, password }) {
  if (!isValidIdentifier(identifier)) { const e = new Error("invalid email or phone"); e.code = "BADINPUT"; throw e; }
  if (!isValidPassword(password)) { const e = new Error("password too short"); e.code = "BADINPUT"; throw e; }
  return insertUser(db, { username: identifier, password, role: "user", status: "pending" });
}
function setUserStatus(db, id, status) {
  if (!VALID_STATUS.includes(status)) throw new Error("invalid status");
  const info = db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
  if (info.changes === 0) throw new Error("no such user");
}
```

Update `listUsers` to include `status`:
```js
function listUsers(db) {
  return db.prepare("SELECT id, username, role, status, created_at FROM users ORDER BY id").all();
}
```
Add `registerUser, setUserStatus` to `module.exports`. (`getUserByUsername`/`getUserById` already `SELECT *`, so they include `status` automatically.)

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS (all register.test.js cases).

- [ ] **Step 5: Commit**
```bash
git add server/lib/users.js server/test/register.test.js
git commit -m "feat(auth): registerUser (pending) + setUserStatus + status in listUsers"
```

---

## Task 4: `POST /api/register`, `/api/me` status, `GET /api/config`

**Files:** Modify `server/routes/auth.js`, `server/routes/meta.js`, `server/app.js` (OPEN); Test `server/test/register.test.js` (add integration cases).

**Interfaces:**
- Consumes: `registerUser` (Task 3).
- Produces: `POST /api/register {identifier,password}` → 200 `{ok:true,status:'pending'}` / 400 / 409; `GET /api/config` → `{whatsapp,telegram}`; `GET /api/me` includes `status`.

- [ ] **Step 1: Implement `POST /api/register`** — in `server/routes/auth.js`, add inside the module function, and import `registerUser`:
```js
// at top: const { getUserByUsername, verifyPassword, registerUser } = require("../lib/users");
  fastify.post("/api/register", async (req, reply) => {
    const { identifier, password } = req.body || {};
    if (fastify.loginThrottle.isLocked(`register|${req.ip}`)) {
      return reply.code(429).send({ error: "too many attempts, try again later" });
    }
    try {
      registerUser(fastify.db, { identifier, password });
      return { ok: true, status: "pending" };
    } catch (e) {
      fastify.loginThrottle.registerFailure(`register|${req.ip}`);
      if (e.code === "DUP") return reply.code(409).send({ error: "that email or phone is already registered" });
      if (e.code === "BADINPUT") return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
```
Change `/api/me` to include status:
```js
    return { id: req.user.id, username: req.user.username, role: req.user.role, status: req.user.status };
```

- [ ] **Step 2: Implement `GET /api/config`** — in `server/routes/meta.js`, add:
```js
  function normLink(v, kind) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (kind === "whatsapp") { const d = s.replace(/[^0-9]/g, ""); return d ? `https://wa.me/${d}` : null; }
    return `https://t.me/${s.replace(/^@/, "")}`;
  }
  fastify.get("/config", async () => ({
    whatsapp: normLink(process.env.STREAMBERT_ADMIN_WHATSAPP, "whatsapp"),
    telegram: normLink(process.env.STREAMBERT_ADMIN_TELEGRAM, "telegram"),
  }));
```

- [ ] **Step 2a: Open the new routes** — in `server/app.js`, add the two public paths to `OPEN` so they're reachable unauthenticated:
```js
const OPEN = ["/api/login", "/api/logout", "/api/events", "/api/register", "/api/config"];
```

- [ ] **Step 3: Write integration tests** — append to `server/test/register.test.js` (reuses `makeApp` pattern from auth.test.js — copy it in):
```js
const os = require("os");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");
const { insertUser } = require("../lib/users");
async function makeApp() {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const app = await buildApp({ db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle({ max: 50, lockoutMs: 1000 }), dataDir: os.tmpdir(), distDir: "/nonexistent" });
  return { app, db };
}
test("POST /api/register creates a pending user (200) and rejects dup (409)", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "z@z.com", password: "password1" } });
  assert.equal(r.statusCode, 200); assert.equal(r.json().status, "pending");
  const dup = await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "z@z.com", password: "password1" } });
  assert.equal(dup.statusCode, 409);
  const bad = await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "nope", password: "password1" } });
  assert.equal(bad.statusCode, 400);
  await app.close();
});
test("GET /api/config returns contact links from env", async () => {
  process.env.STREAMBERT_ADMIN_WHATSAPP = "+1 (555) 123-4567";
  process.env.STREAMBERT_ADMIN_TELEGRAM = "@streambertadmin";
  const { app } = await makeApp();
  const c = await app.inject({ method: "GET", url: "/api/config" });
  assert.equal(c.json().whatsapp, "https://wa.me/15551234567");
  assert.equal(c.json().telegram, "https://t.me/streambertadmin");
  delete process.env.STREAMBERT_ADMIN_WHATSAPP; delete process.env.STREAMBERT_ADMIN_TELEGRAM;
  await app.close();
});
```

- [ ] **Step 4: Run to verify** — `cd server && node --test test/register.test.js`. Expected: register (200/409/400) + config tests PASS (routes are now open via Step 2a).

- [ ] **Step 5: Commit**
```bash
git add server/routes/auth.js server/routes/meta.js server/app.js server/test/register.test.js
git commit -m "feat(auth): POST /api/register, /api/config contact links, status in /api/me"
```

---

## Task 5: app.js — status gate + open the new routes + gate /vzy

**Files:** Modify `server/app.js`; Test `server/test/register.test.js` (add gate cases).

**Interfaces:** Consumes: `req.user.status`. Produces: non-active users are 403'd on content; `/api/register` + `/api/config` open; `/vzy` requires an active user.

- [ ] **Step 1: Write the failing gate test** — append to `server/test/register.test.js`:
```js
async function loginCookie(app, username, password) {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  return r.cookies.find((c) => c.name === "sb_session").value;
}
test("pending user: /api/me OK but content is 403; active user OK", async () => {
  const { app, db } = await makeApp();
  await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "pend@x.com", password: "password1" } });
  const cookie = await loginCookie(app, "pend@x.com", "password1");
  const me = await app.inject({ method: "GET", url: "/api/me", cookies: { sb_session: cookie } });
  assert.equal(me.statusCode, 200); assert.equal(me.json().status, "pending");
  const content = await app.inject({ method: "GET", url: "/api/state/bootstrap", cookies: { sb_session: cookie } });
  assert.equal(content.statusCode, 403);
  const vzy = await app.inject({ method: "GET", url: "/vzy/p/movie/550", cookies: { sb_session: cookie } });
  assert.equal(vzy.statusCode, 403);
  // admin (active) can hit content
  const acookie = await loginCookie(app, "admin", "adminpass");
  const ok = await app.inject({ method: "GET", url: "/api/state/bootstrap", cookies: { sb_session: acookie } });
  assert.equal(ok.statusCode, 200);
  await app.close();
});
test("/vzy requires a session (401 anon)", async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: "GET", url: "/vzy/p/movie/550" });
  assert.equal(r.statusCode, 401);
  await app.close();
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && node --test test/register.test.js`. Expected: FAIL (pending user reaches content / vzy not gated).

- [ ] **Step 3: Implement** — in `server/app.js`:

`resolveUser` must include `status`:
```js
  return user ? { id: user.id, username: user.username, role: user.role, status: user.status } : null;
```
(`OPEN` already includes `/api/register` + `/api/config` from Task 4 Step 2a.)
Replace the preHandler with one that also covers `/vzy` and enforces status:
```js
  fastify.addHook("preHandler", async (req, reply) => {
    const isApi = req.url.startsWith("/api/");
    const isVzy = req.url.startsWith("/vzy");
    if (!isApi && !isVzy) return;
    req.user = resolveUser(fastify, req);
    if (isApi && OPEN.some((p) => req.url.startsWith(p))) return;
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
    // Pending/suspended accounts may reach only /api/me (+ /api/logout via OPEN).
    if (req.user.status !== "active" && !req.url.startsWith("/api/me")) {
      return reply.code(403).send({ error: "account not active", status: req.user.status });
    }
  });
```

- [ ] **Step 4: Run to verify it passes**
```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
cd server && node --test test/
```
Expected: whole suite PASS (register + gate + existing).

- [ ] **Step 5: Commit**
```bash
git add server/app.js server/test/register.test.js
git commit -m "feat(auth): 403 non-active users on content, gate /vzy, open register/config"
```

---

## Task 6: admin activate / suspend

**Files:** Modify `server/routes/admin.js`; Test `server/test/admin.test.js` (add).

**Interfaces:** Consumes: `setUserStatus` (Task 3). Produces: `POST /api/admin/users/:id/activate`, `POST /api/admin/users/:id/suspend`.

- [ ] **Step 1: Write the failing test** — append to `server/test/admin.test.js` (reuse its existing makeApp/admin-login helpers; match their names — grep the file):
```js
test("admin can activate and suspend a pending user", async () => {
  const { app, db } = await makeAdminApp(); // use whatever the file's helper is named
  const reg = await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "p@p.com", password: "password1" } });
  const id = db.prepare("SELECT id FROM users WHERE username='p@p.com' COLLATE NOCASE").get().id;
  const cookie = await adminCookie(app); // reuse the file's admin-login helper
  const act = await app.inject({ method: "POST", url: `/api/admin/users/${id}/activate`, cookies: { sb_session: cookie } });
  assert.equal(act.statusCode, 200);
  assert.equal(db.prepare("SELECT status FROM users WHERE id=?").get(id).status, "active");
  const sus = await app.inject({ method: "POST", url: `/api/admin/users/${id}/suspend`, cookies: { sb_session: cookie } });
  assert.equal(sus.statusCode, 200);
  assert.equal(db.prepare("SELECT status FROM users WHERE id=?").get(id).status, "disabled");
  await app.close();
});
```
(If `admin.test.js` has no reusable helper, copy the `makeApp` + `loginCookie` pattern from `register.test.js` and log in as `admin`/`adminpass`.)

- [ ] **Step 2: Run to verify it fails** — `cd server && node --test test/admin.test.js`. Expected: FAIL (404 — routes missing).

- [ ] **Step 3: Implement** — in `server/routes/admin.js`, add (near the other user routes), importing `setUserStatus` from `../lib/users`:
```js
  fastify.post("/api/admin/users/:id/activate", async (req, reply) => {
    try { setUserStatus(fastify.db, Number(req.params.id), "active"); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  fastify.post("/api/admin/users/:id/suspend", async (req, reply) => {
    try { setUserStatus(fastify.db, Number(req.params.id), "disabled"); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
```
(The file already has an admin role guard applied to `/api/admin/*` — confirm the new routes sit under it; they're registered the same way as the existing `/api/admin/users/:id/reset-password`.)

- [ ] **Step 4: Run to verify it passes** — `cd server && node --test test/`. Expected: whole suite PASS.

- [ ] **Step 5: Commit**
```bash
git add server/routes/admin.js server/test/admin.test.js
git commit -m "feat(admin): activate/suspend user endpoints"
```

---

## Task 7: Client — register form in LoginGate

**Files:** Modify `src/components/LoginGate.jsx`.

**Interfaces:** Consumes: `POST /api/register`.

- [ ] **Step 1: Read the current LoginGate** to match its style (how it posts to `/api/login`, its state, its styling). Then add a mode toggle: a link "Create an account" that swaps the login form for a register form with fields **Email or phone**, **Password**, **Confirm password**, and a submit that:
```js
// register submit handler (match LoginGate's existing fetch/style)
const res = await fetch("/api/register", {
  method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
  body: JSON.stringify({ identifier, password }),
});
if (res.ok) { setRegistered(true); /* show success message */ }
else { const j = await res.json().catch(() => ({})); setError(j.error || "Registration failed"); }
```
Client-side pre-check before submit: identifier non-empty and looks like an email or phone (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || v.replace(/[^0-9]/g,"").length >= 7`), password length ≥ 8, password === confirm. On success show: **"Account created — an admin will approve it shortly. You can log in once approved."** with a link back to the login form.

- [ ] **Step 2: Verify build**
```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: `✓ built`, no errors.

- [ ] **Step 3: Commit**
```bash
git add src/components/LoginGate.jsx
git commit -m "feat(web): self-registration form in the login gate"
```

---

## Task 8: Client — PendingScreen + App gate (with contact links)

**Files:** Create `src/components/PendingScreen.jsx`; Modify `src/App.jsx`.

**Interfaces:** Consumes: `me.status` (from `/api/me`), `GET /api/config`.

- [ ] **Step 1: Create `src/components/PendingScreen.jsx`:**
```js
import { useEffect, useState } from "react";

// Shown full-screen when the logged-in account is not active. Offers WhatsApp /
// Telegram links (from /api/config) so the user can ask the admin to approve.
export default function PendingScreen({ status, onLogout }) {
  const [links, setLinks] = useState({ whatsapp: null, telegram: null });
  useEffect(() => {
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.json()).then(setLinks).catch(() => {});
  }, []);
  const suspended = status === "disabled";
  const box = { position: "fixed", inset: 0, display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 18, textAlign: "center",
    background: "var(--bg1, #0b0b0b)", color: "var(--text1, #fff)", padding: 24 };
  const btn = { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px",
    borderRadius: 8, textDecoration: "none", fontWeight: 600, color: "#fff" };
  return (
    <div style={box}>
      <h1 style={{ margin: 0 }}>{suspended ? "Account suspended" : "Awaiting approval"}</h1>
      <p style={{ maxWidth: 420, color: "var(--text2, #bbb)", margin: 0 }}>
        {suspended
          ? "Your account has been suspended. Contact the admin if you think this is a mistake."
          : "Your account was created and is waiting for an admin to approve it. Message the admin to get activated:"}
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        {links.whatsapp && <a style={{ ...btn, background: "#25D366" }} href={links.whatsapp} target="_blank" rel="noreferrer">WhatsApp</a>}
        {links.telegram && <a style={{ ...btn, background: "#229ED9" }} href={links.telegram} target="_blank" rel="noreferrer">Telegram</a>}
      </div>
      <button className="btn" onClick={onLogout} style={{ marginTop: 8 }}>Log out</button>
    </div>
  );
}
```

- [ ] **Step 2: Gate in `src/App.jsx`** — find where `me` is loaded (from `/api/me`) and the app decides logged-in vs LoginGate. Add: import `PendingScreen`, and when `me` exists but `me.status && me.status !== "active"`, render `<PendingScreen status={me.status} onLogout={<the existing logout handler>} />` instead of the main app. (Grep `App.jsx` for `/api/me`, `LoginGate`, and the logout handler to wire the exact names.)

- [ ] **Step 3: Verify build**
```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: `✓ built`, no errors.

- [ ] **Step 4: Commit**
```bash
git add src/components/PendingScreen.jsx src/App.jsx
git commit -m "feat(web): pending-approval screen with WhatsApp/Telegram contact links"
```

---

## Task 9: Client — admin pending list + badge + activate/reject

**Files:** Modify `src/components/UsersAdminPanel.jsx`.

**Interfaces:** Consumes: `GET /api/admin/users` (now includes `status`), `POST /api/admin/users/:id/activate`, `DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/suspend`.

- [ ] **Step 1: Read the current UsersAdminPanel** to match its data-loading + button style. Then:
  - Derive `pending = users.filter(u => u.status === "pending")`.
  - Render a **"Pending approval"** section at the top (only when `pending.length`), each row: identifier + **Activate** (`POST .../activate`) and **Reject** (`DELETE .../:id`) buttons, then refetch the list.
  - Add a **count badge** showing `pending.length` on the section header (e.g. `Pending approval ({pending.length})`).
  - In the existing users list, show each user's `status` and an **Activate/Suspend** toggle (active↔disabled) using the activate/suspend endpoints.
```js
const activate = async (id) => { await fetch(`/api/admin/users/${id}/activate`, { method: "POST", credentials: "include" }); reload(); };
const suspend  = async (id) => { await fetch(`/api/admin/users/${id}/suspend`,  { method: "POST", credentials: "include" }); reload(); };
const reject   = async (id) => { await fetch(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" }); reload(); };
```
(`reload` = the panel's existing users-refetch function — reuse it.)

- [ ] **Step 2: Verify build**
```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: `✓ built`, no errors.

- [ ] **Step 3: Manual verification pass** (web build):
  1. Register a new account → see "awaiting approval, an admin will approve" message.
  2. Log in as that account → **PendingScreen** with WhatsApp + Telegram buttons (set `STREAMBERT_ADMIN_WHATSAPP`/`STREAMBERT_ADMIN_TELEGRAM` on the server first); content is not reachable.
  3. As admin → Admin panel shows **Pending approval (1)** with the new user → click **Activate**.
  4. Back as the user (reload) → app loads, can watch.
  5. As admin → **Suspend** the user → user reload → PendingScreen ("suspended").
  6. **Reject** a pending user → it disappears and that login no longer works.

- [ ] **Step 4: Commit**
```bash
git add src/components/UsersAdminPanel.jsx
git commit -m "feat(admin): pending-approval list with badge + activate/suspend/reject"
```

---

## Notes for the implementer

- The desktop Electron build shares `src/` but its auth path differs; these changes are web-relevant (public deployment). Don't touch Electron-only files.
- Deploy is separate (rebuild image on Vision) and gated on Philip's go — not part of this plan.
- Set `STREAMBERT_ADMIN_WHATSAPP` / `STREAMBERT_ADMIN_TELEGRAM` in the container env at deploy so the pending screen shows the contact buttons (Philip provides the actual number/handle).
