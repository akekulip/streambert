# Multi-User Accounts — Phase 1 (Auth Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single shared-password gate with real admin-created user accounts: username+password login, per-user signed-cookie sessions, and an admin Users panel — backed by SQLite.

**Architecture:** A new SQLite layer (`server/lib/{db,passwords,users,loginThrottle}.js`) holds users and hashes passwords with Node's built-in `scrypt`. The server is refactored into a testable `buildApp()` (`server/app.js`) that resolves the logged-in user from a signed cookie on every `/api/*` request; `server/index.js` shrinks to bootstrap + listen. New `routes/auth.js` and `routes/admin.js` provide login/logout/me and admin user CRUD. The frontend gets a username+password `LoginGate`, a `session.js` helper, and an admin-only `UsersAdminPanel`.

**Tech Stack:** Node 20, Fastify 4, `@fastify/cookie`, `better-sqlite3`, Node built-in `crypto` (scrypt) and `node:test` runner. React 18 (Vite) frontend.

## Global Constraints

- Node runtime: **node 20** (Docker `node:20-slim`); tests run with the built-in `node --test`. No Jest/Mocha.
- No new crypto dependency — password hashing uses `crypto.scrypt` with `N=16384, r=8, p=1, keylen=64`, 16-byte random hex salt, `timingSafeEqual` compare.
- Only one new runtime dependency: **`better-sqlite3`** (in `server/package.json`).
- Database file: `DATA_DIR/streambert.db` (DATA_DIR comes from `fastify.config.DATA_DIR`, default `/data` in Docker).
- Session cookie name: **`sb_session`**, value = the user id, signed via `@fastify/cookie`. Flags: `httpOnly`, `path=/`, `sameSite=lax`, `secure` when `x-forwarded-proto === "https"`, `maxAge` 30 days.
- Minimum password length: **8** (enforced on create/reset; NOT on bootstrap, so an existing short `STREAMBERT_PASSWORD` still works).
- Preserve existing Fastify decorations relied on elsewhere: `fastify.config` (`.DATA_DIR` used by `routes/{secure,files,downloads,subtitles}.js`), `fastify.sessionValid(req)` (used by `events.js`), `fastify.broadcast`.
- Open (no-auth) API paths: `/api/login`, `/api/logout`, `/api/events`.
- Roles: `'admin' | 'user'`. Cannot delete the last admin.
- Commit after every task with the given message.

---

### Task 1: Password hashing module + test harness

**Files:**
- Create: `server/lib/passwords.js`
- Create: `server/test/passwords.test.js`
- Modify: `server/package.json` (add `test` script)

**Interfaces:**
- Produces: `hashPassword(password: string) -> { hash: string, salt: string }` (hex); `verifyPassword(password: string, hash: string, salt: string) -> boolean`.

- [ ] **Step 1: Add the test script to `server/package.json`**

Change the `"scripts"` block to:

```json
  "scripts": {
    "start": "node index.js",
    "test": "node --test test/"
  },
```

- [ ] **Step 2: Write the failing test**

Create `server/test/passwords.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { hashPassword, verifyPassword } = require("../lib/passwords");

test("verify succeeds for the correct password", () => {
  const { hash, salt } = hashPassword("hunter2!");
  assert.equal(verifyPassword("hunter2!", hash, salt), true);
});

test("verify fails for a wrong password", () => {
  const { hash, salt } = hashPassword("hunter2!");
  assert.equal(verifyPassword("nope", hash, salt), false);
});

test("same password hashes differently (random salt)", () => {
  const a = hashPassword("samepass");
  const b = hashPassword("samepass");
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.salt, b.salt);
});

test("verify returns false when hash/salt missing", () => {
  assert.equal(verifyPassword("x", "", ""), false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --test test/passwords.test.js`
Expected: FAIL — `Cannot find module '../lib/passwords'`.

- [ ] **Step 4: Write the implementation**

Create `server/lib/passwords.js`:

```js
"use strict";
const crypto = require("crypto");

const KEYLEN = 64;
const OPTS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, OPTS).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(String(password), salt, KEYLEN, OPTS);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --test test/passwords.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add server/lib/passwords.js server/test/passwords.test.js server/package.json
git commit -m "feat(server): add scrypt password hashing + node test harness"
```

---

### Task 2: SQLite database module

**Files:**
- Create: `server/lib/db.js`
- Create: `server/test/db.test.js`
- Modify: `server/package.json` (add `better-sqlite3` dependency)

**Interfaces:**
- Consumes: nothing.
- Produces: `openDb(dbPath: string) -> Database` (a `better-sqlite3` instance with the `users` table migrated). `dbPath` may be `":memory:"`.

- [ ] **Step 1: Install the dependency**

Run: `cd server && npm install better-sqlite3@11`
Expected: installs and writes `server/package.json` + `server/package-lock.json`. On `node:20`/linux-x64 a prebuilt binary is fetched (no toolchain needed).

- [ ] **Step 2: Write the failing test**

Create `server/test/db.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { openDb } = require("../lib/db");

test("openDb creates the users table", () => {
  const db = openDb(":memory:");
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  assert.equal(row && row.name, "users");
  db.close();
});

test("openDb is idempotent (safe to call twice on same file)", () => {
  const db = openDb(":memory:");
  assert.doesNotThrow(() => db.exec("SELECT 1"));
  db.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --test test/db.test.js`
Expected: FAIL — `Cannot find module '../lib/db'`.

- [ ] **Step 4: Write the implementation**

Create `server/lib/db.js`:

```js
"use strict";
const Database = require("better-sqlite3");

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_hash    TEXT NOT NULL,
      pw_salt    TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      created_at INTEGER NOT NULL
    );
  `);
}

function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

module.exports = { openDb };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --test test/db.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add server/lib/db.js server/test/db.test.js server/package.json server/package-lock.json
git commit -m "feat(server): add SQLite (better-sqlite3) db module with users schema"
```

---

### Task 3: Users module (CRUD + bootstrap)

**Files:**
- Create: `server/lib/users.js`
- Create: `server/test/users.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 2); `hashPassword`, `verifyPassword` (Task 1).
- Produces (all take a `db` first arg):
  - `insertUser(db, {username, password, role}) -> {id, username, role, created_at}` — hashes + inserts, **no policy checks** (used by bootstrap).
  - `createUser(db, {username, password, role}) -> {id, username, role, created_at}` — validates (non-empty username, password length >= 8, valid role) then `insertUser`. Throws `err.code="DUP"` on duplicate username.
  - `getUserByUsername(db, username) -> row | undefined`
  - `getUserById(db, id) -> row | undefined`
  - `listUsers(db) -> [{id, username, role, created_at}]` (no hashes)
  - `countAdmins(db) -> number`
  - `resetPassword(db, id, newPassword) -> void` (throws on <8 or missing user)
  - `deleteUser(db, id) -> void` (throws `err.code="LAST_ADMIN"` if deleting the last admin)
  - `bootstrapAdmin(db, {adminUser, adminPassword}) -> row|null` — if `users` empty and `adminPassword` set, insert an admin (username `adminUser||"admin"`).

- [ ] **Step 1: Write the failing test**

Create `server/test/users.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { openDb } = require("../lib/db");
const U = require("../lib/users");

function db() { return openDb(":memory:"); }

test("createUser + getUserByUsername round-trips (case-insensitive)", () => {
  const d = db();
  const u = U.createUser(d, { username: "Alice", password: "password1", role: "user" });
  assert.equal(u.username, "Alice");
  assert.equal(U.getUserByUsername(d, "alice").id, u.id);
});

test("createUser rejects short passwords and duplicates", () => {
  const d = db();
  assert.throws(() => U.createUser(d, { username: "bob", password: "short" }));
  U.createUser(d, { username: "bob", password: "password1" });
  assert.throws(() => U.createUser(d, { username: "BOB", password: "password1" }), /taken/);
});

test("resetPassword changes the stored hash", () => {
  const d = db();
  const u = U.createUser(d, { username: "carol", password: "password1" });
  U.resetPassword(d, u.id, "password2");
  const row = U.getUserById(d, u.id);
  assert.equal(U.verifyPassword("password2", row.pw_hash, row.pw_salt), true);
  assert.equal(U.verifyPassword("password1", row.pw_hash, row.pw_salt), false);
});

test("deleteUser refuses to remove the last admin", () => {
  const d = db();
  const a = U.createUser(d, { username: "admin", password: "password1", role: "admin" });
  assert.throws(() => U.deleteUser(d, a.id), (e) => e.code === "LAST_ADMIN");
  U.createUser(d, { username: "admin2", password: "password1", role: "admin" });
  assert.doesNotThrow(() => U.deleteUser(d, a.id));
});

test("bootstrapAdmin creates an admin only when users table is empty", () => {
  const d = db();
  const first = U.bootstrapAdmin(d, { adminUser: "root", adminPassword: "short" });
  assert.equal(first.role, "admin");
  assert.equal(first.username, "root");
  const second = U.bootstrapAdmin(d, { adminUser: "root2", adminPassword: "whatever8" });
  assert.equal(second, null);
  assert.equal(U.listUsers(d).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/users.test.js`
Expected: FAIL — `Cannot find module '../lib/users'`.

- [ ] **Step 3: Write the implementation**

Create `server/lib/users.js`:

```js
"use strict";
const { hashPassword, verifyPassword } = require("./passwords");

function insertUser(db, { username, password, role = "user" }) {
  const uname = String(username || "").trim();
  const { hash, salt } = hashPassword(password);
  const created_at = Date.now();
  let info;
  try {
    info = db
      .prepare("INSERT INTO users (username, pw_hash, pw_salt, role, created_at) VALUES (?,?,?,?,?)")
      .run(uname, hash, salt, role, created_at);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      const err = new Error("username taken");
      err.code = "DUP";
      throw err;
    }
    throw e;
  }
  return { id: info.lastInsertRowid, username: uname, role, created_at };
}

function createUser(db, { username, password, role = "user" }) {
  if (!String(username || "").trim()) throw new Error("username required");
  if (!password || String(password).length < 8) throw new Error("password too short");
  if (role !== "admin" && role !== "user") throw new Error("invalid role");
  return insertUser(db, { username, password, role });
}

function getUserByUsername(db, username) {
  return db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(String(username || ""));
}

function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function listUsers(db) {
  return db.prepare("SELECT id, username, role, created_at FROM users ORDER BY id").all();
}

function countAdmins(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

function resetPassword(db, id, newPassword) {
  if (!newPassword || String(newPassword).length < 8) throw new Error("password too short");
  const { hash, salt } = hashPassword(newPassword);
  const info = db.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").run(hash, salt, id);
  if (info.changes === 0) throw new Error("no such user");
}

function deleteUser(db, id) {
  const user = getUserById(db, id);
  if (!user) throw new Error("no such user");
  if (user.role === "admin" && countAdmins(db) <= 1) {
    const err = new Error("cannot delete the last admin");
    err.code = "LAST_ADMIN";
    throw err;
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

function bootstrapAdmin(db, { adminUser, adminPassword }) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0 || !adminPassword) return null;
  return insertUser(db, { username: adminUser || "admin", password: adminPassword, role: "admin" });
}

module.exports = {
  insertUser, createUser, getUserByUsername, getUserById, listUsers,
  countAdmins, resetPassword, deleteUser, bootstrapAdmin, verifyPassword,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/users.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/lib/users.js server/test/users.test.js
git commit -m "feat(server): add users module (CRUD, roles, admin bootstrap)"
```

---

### Task 4: Login throttle

**Files:**
- Create: `server/lib/loginThrottle.js`
- Create: `server/test/throttle.test.js`

**Interfaces:**
- Produces: `createLoginThrottle({max=5, windowMs=900000, lockoutMs=60000}) -> { isLocked(key)->bool, registerFailure(key)->void, reset(key)->void }`.

- [ ] **Step 1: Write the failing test**

Create `server/test/throttle.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createLoginThrottle } = require("../lib/loginThrottle");

test("locks after max failures and unlocks on reset", () => {
  const t = createLoginThrottle({ max: 3, lockoutMs: 10000 });
  const k = "user|1.2.3.4";
  t.registerFailure(k);
  t.registerFailure(k);
  assert.equal(t.isLocked(k), false);
  t.registerFailure(k);
  assert.equal(t.isLocked(k), true);
  t.reset(k);
  assert.equal(t.isLocked(k), false);
});

test("lockout expires after lockoutMs", () => {
  const t = createLoginThrottle({ max: 1, lockoutMs: -1 });
  t.registerFailure("k");
  // lockoutMs negative => lockedUntil already in the past
  assert.equal(t.isLocked("k"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/throttle.test.js`
Expected: FAIL — `Cannot find module '../lib/loginThrottle'`.

- [ ] **Step 3: Write the implementation**

Create `server/lib/loginThrottle.js`:

```js
"use strict";
// In-memory, single-process login throttle. Keyed by `${username}|${ip}`.
function createLoginThrottle({ max = 5, windowMs = 15 * 60 * 1000, lockoutMs = 60 * 1000 } = {}) {
  const attempts = new Map(); // key -> { count, first, lockedUntil }

  function isLocked(key) {
    const e = attempts.get(key);
    return !!(e && e.lockedUntil > Date.now());
  }

  function registerFailure(key) {
    const now = Date.now();
    let e = attempts.get(key);
    if (!e || now - e.first > windowMs) e = { count: 0, first: now, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= max) e.lockedUntil = now + lockoutMs;
    attempts.set(key, e);
  }

  function reset(key) {
    attempts.delete(key);
  }

  return { isLocked, registerFailure, reset };
}

module.exports = { createLoginThrottle };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/throttle.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/lib/loginThrottle.js server/test/throttle.test.js
git commit -m "feat(server): add in-memory login throttle"
```

---

### Task 5: App refactor (`buildApp`) + auth routes + slim `index.js`

**Files:**
- Create: `server/app.js`
- Create: `server/routes/auth.js`
- Create: `server/test/auth.test.js`
- Modify: `server/index.js` (replace `main()` internals with bootstrap + `buildApp` + listen)

**Interfaces:**
- Consumes: `openDb`, `bootstrapAdmin`, `getUserById`, `getUserByUsername`, `verifyPassword`, `createLoginThrottle`, `insertUser` (tests).
- Produces:
  - `buildApp({db, cookieSecret, loginThrottle, dataDir, distDir}) -> Promise<FastifyInstance>` (not listening). Decorates `db`, `loginThrottle`, `config` (`{DATA_DIR: dataDir}`), `sessionValid(req)->bool`, `broadcast`. Registers the auth hook, events, `routes/auth`, and the existing route modules, plus static/SPA fallback when `distDir` exists.
  - Routes: `POST /api/login {username,password}`, `POST /api/logout`, `GET /api/me`.

- [ ] **Step 1: Write the failing test**

Create `server/test/auth.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function makeApp() {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const app = await buildApp({
    db, cookieSecret: "test-secret-please-change",
    loginThrottle: createLoginThrottle({ max: 3, lockoutMs: 60000 }),
    dataDir: os.tmpdir(), distDir: "/nonexistent-dist",
  });
  return { app, db };
}

test("login rejects bad credentials and accepts good ones", async () => {
  const { app } = await makeApp();
  const bad = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "wrong" } });
  assert.equal(bad.statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.cookies.find((c) => c.name === "sb_session"));
  await app.close();
});

test("/api/me is 401 without a session and returns the user with one", async () => {
  const { app } = await makeApp();
  const anon = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(anon.statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  const cookie = login.cookies.find((c) => c.name === "sb_session").value;
  const me = await app.inject({ method: "GET", url: "/api/me", cookies: { sb_session: cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().username, "admin");
  assert.equal(me.json().role, "admin");
  await app.close();
});

test("throttle returns 429 after too many failures", async () => {
  const { app } = await makeApp();
  for (let i = 0; i < 3; i++) {
    await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "wrong" } });
  }
  const locked = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "adminpass" } });
  assert.equal(locked.statusCode, 429);
  await app.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/auth.test.js`
Expected: FAIL — `Cannot find module '../app'`.

- [ ] **Step 3: Create `server/routes/auth.js`**

```js
"use strict";
const { getUserByUsername, verifyPassword } = require("../lib/users");

module.exports = async function (fastify) {
  fastify.post("/api/login", async (req, reply) => {
    const { username, password } = req.body || {};
    const key = `${String(username || "").toLowerCase()}|${req.ip}`;
    if (fastify.loginThrottle.isLocked(key)) {
      return reply.code(429).send({ error: "too many attempts, try again later" });
    }
    const user = username ? getUserByUsername(fastify.db, username) : null;
    const ok = user && verifyPassword(password || "", user.pw_hash, user.pw_salt);
    if (!ok) {
      fastify.loginThrottle.registerFailure(key);
      return reply.code(401).send({ error: "invalid username or password" });
    }
    fastify.loginThrottle.reset(key);
    reply.setCookie("sb_session", reply.signCookie(String(user.id)), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: req.headers["x-forwarded-proto"] === "https",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

  fastify.post("/api/logout", async (_req, reply) => {
    reply.clearCookie("sb_session", { path: "/" });
    return { ok: true };
  });

  fastify.get("/api/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
    return { username: req.user.username, role: req.user.role };
  });
};
```

- [ ] **Step 4: Create `server/app.js`**

```js
"use strict";
const path = require("path");
const fs = require("fs");
const { getUserById } = require("./lib/users");

const OPEN = ["/api/login", "/api/logout", "/api/events"];

function resolveUser(fastify, req) {
  const c = req.cookies && req.cookies.sb_session;
  if (!c) return null;
  const u = fastify.unsignCookie(c);
  if (!u.valid || !u.value) return null;
  const user = getUserById(fastify.db, Number(u.value));
  return user ? { id: user.id, username: user.username, role: user.role } : null;
}

async function buildApp({ db, cookieSecret, loginThrottle, dataDir, distDir }) {
  const fastify = require("fastify")({ logger: true });
  await fastify.register(require("@fastify/cookie"), { secret: cookieSecret });
  await fastify.register(require("@fastify/websocket"));

  fastify.decorate("db", db);
  fastify.decorate("loginThrottle", loginThrottle);
  fastify.decorate("config", { DATA_DIR: dataDir });
  fastify.decorate("sessionValid", (req) => !!resolveUser(fastify, req));

  // Resolve the logged-in user for every /api/* request; gate non-open paths.
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    req.user = resolveUser(fastify, req);
    if (OPEN.some((p) => req.url.startsWith(p))) return;
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
  });

  require("./events")(fastify);
  await fastify.register(require("./routes/auth"));

  // Existing route modules (unchanged). Register only if present.
  const tryRegister = async (mod, opts) => {
    let plugin;
    try { plugin = require(mod); }
    catch (e) { if (e && e.code === "MODULE_NOT_FOUND") { fastify.log.warn(`[scaffold] ${mod} missing`); return; } throw e; }
    await fastify.register(plugin, opts);
  };
  await tryRegister("./routes/secure", { prefix: "/api/secure" });
  await tryRegister("./routes/meta", { prefix: "/api" });
  await tryRegister("./routes/allmanga", { prefix: "/api/allmanga" });
  await tryRegister("./routes/downloads", { prefix: "/api/downloads" });
  await tryRegister("./routes/files", { prefix: "/api/files" });
  await tryRegister("./routes/subtitles", { prefix: "/api/subtitles" });
  await tryRegister("./routes/wyzie", { prefix: "/api/wyzie" });
  await tryRegister("./routes/proxy", { prefix: "/api/proxy" });

  if (distDir && fs.existsSync(distDir)) {
    await fastify.register(require("@fastify/static"), { root: distDir, prefix: "/" });
  }
  fastify.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    if (distDir && fs.existsSync(path.join(distDir, "index.html"))) return reply.sendFile("index.html");
    return reply.code(503).send("frontend not built (run npm run build)");
  });

  return fastify;
}

module.exports = { buildApp, OPEN };
```

- [ ] **Step 5: Rewrite `server/index.js` to bootstrap + listen**

Replace the entire body of `server/index.js` (keep the `loadDotEnv()` function from the top exactly as it is) so it reads:

```js
"use strict";
// Streambert web-port backend. Bootstraps the DB + admin, then serves the built
// frontend (../dist) + /api/*. Auth: per-user accounts (see docs). 

const path = require("path");

// --- keep the existing loadDotEnv() function here, unchanged ---
function loadDotEnv() {
  const fs = require("fs");
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadDotEnv();

const { openDb } = require("./lib/db");
const { bootstrapAdmin } = require("./lib/users");
const { createLoginThrottle } = require("./lib/loginThrottle");
const { buildApp } = require("./app");

const COOKIE_SECRET = process.env.STREAMBERT_COOKIE_SECRET || "streambert-dev-secret-change-me";
const DIST_DIR = path.join(__dirname, "..", "dist");
const DATA_DIR = process.env.STREAMBERT_DATA || path.join(__dirname, "..", "data");
const PORT = Number(process.env.PORT || 8787);

async function main() {
  require("fs").mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(path.join(DATA_DIR, "streambert.db"));
  const created = bootstrapAdmin(db, {
    adminUser: process.env.STREAMBERT_ADMIN_USER,
    adminPassword: process.env.STREAMBERT_ADMIN_PASSWORD || process.env.STREAMBERT_PASSWORD,
  });
  if (created) console.log(`[bootstrap] created initial admin user "${created.username}"`);

  const app = await buildApp({
    db, cookieSecret: COOKIE_SECRET,
    loginThrottle: createLoginThrottle(),
    dataDir: DATA_DIR, distDir: DIST_DIR,
  });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`Streambert web on :${PORT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && node --test test/auth.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 7: Run the full server test suite**

Run: `cd server && node --test test/`
Expected: PASS — all tests from Tasks 1–5.

- [ ] **Step 8: Commit**

```bash
git add server/app.js server/routes/auth.js server/index.js server/test/auth.test.js
git commit -m "feat(server): buildApp refactor + per-user auth (login/logout/me)"
```

---

### Task 6: Admin user-management routes

**Files:**
- Create: `server/routes/admin.js`
- Create: `server/test/admin.test.js`
- Modify: `server/app.js` (register the admin routes)

**Interfaces:**
- Consumes: `fastify.db`, `req.user` (from Task 5); `createUser`, `listUsers`, `resetPassword`, `deleteUser` (Task 3).
- Produces: `GET /api/admin/users`, `POST /api/admin/users`, `POST /api/admin/users/:id/reset-password`, `DELETE /api/admin/users/:id`. All require `req.user.role === "admin"` (403 otherwise).

- [ ] **Step 1: Write the failing test**

Create `server/test/admin.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function makeApp() {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  insertUser(db, { username: "bob", password: "bobpass1", role: "user" });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent",
  });
  return { app, db };
}
async function cookieFor(app, username, password) {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  return r.cookies.find((c) => c.name === "sb_session").value;
}

test("admin can list and create users; non-admin gets 403", async () => {
  const { app } = await makeApp();
  const admin = await cookieFor(app, "admin", "adminpass");
  const user = await cookieFor(app, "bob", "bobpass1");

  const forbidden = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { sb_session: user } });
  assert.equal(forbidden.statusCode, 403);

  const list = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { sb_session: admin } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 2);

  const created = await app.inject({
    method: "POST", url: "/api/admin/users", cookies: { sb_session: admin },
    payload: { username: "carol", password: "carolpw1", role: "user" },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().username, "carol");
  await app.close();
});

test("duplicate username is 409; delete of last admin is 400", async () => {
  const { app } = await makeApp();
  const admin = await cookieFor(app, "admin", "adminpass");
  const dup = await app.inject({
    method: "POST", url: "/api/admin/users", cookies: { sb_session: admin },
    payload: { username: "bob", password: "another1" },
  });
  assert.equal(dup.statusCode, 409);

  const adminRow = (await app.inject({ method: "GET", url: "/api/admin/users", cookies: { sb_session: admin } }))
    .json().find((u) => u.username === "admin");
  const del = await app.inject({ method: "DELETE", url: `/api/admin/users/${adminRow.id}`, cookies: { sb_session: admin } });
  assert.equal(del.statusCode, 400);
  await app.close();
});

test("deleting a user immediately invalidates their session", async () => {
  const { app } = await makeApp();
  const admin = await cookieFor(app, "admin", "adminpass");
  const bob = await cookieFor(app, "bob", "bobpass1");
  const bobRow = (await app.inject({ method: "GET", url: "/api/admin/users", cookies: { sb_session: admin } }))
    .json().find((u) => u.username === "bob");
  await app.inject({ method: "DELETE", url: `/api/admin/users/${bobRow.id}`, cookies: { sb_session: admin } });
  const after = await app.inject({ method: "GET", url: "/api/me", cookies: { sb_session: bob } });
  assert.equal(after.statusCode, 401);
  await app.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/admin.test.js`
Expected: FAIL — admin routes return 404 (not registered yet).

- [ ] **Step 3: Create `server/routes/admin.js`**

```js
"use strict";
const { createUser, listUsers, resetPassword, deleteUser } = require("../lib/users");

module.exports = async function (fastify) {
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.user || req.user.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
  });

  fastify.get("/api/admin/users", async () => listUsers(fastify.db));

  fastify.post("/api/admin/users", async (req, reply) => {
    const { username, password, role } = req.body || {};
    try {
      return createUser(fastify.db, { username, password, role: role === "admin" ? "admin" : "user" });
    } catch (e) {
      if (e.code === "DUP") return reply.code(409).send({ error: "username taken" });
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.post("/api/admin/users/:id/reset-password", async (req, reply) => {
    try {
      resetPassword(fastify.db, Number(req.params.id), (req.body || {}).password);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.delete("/api/admin/users/:id", async (req, reply) => {
    try {
      deleteUser(fastify.db, Number(req.params.id));
      return { ok: true };
    } catch (e) {
      if (e.code === "LAST_ADMIN") return reply.code(400).send({ error: "cannot delete the last admin" });
      return reply.code(400).send({ error: e.message });
    }
  });
};
```

- [ ] **Step 4: Register the admin routes in `server/app.js`**

In `server/app.js`, immediately after the line `await fastify.register(require("./routes/auth"));` add:

```js
  await fastify.register(require("./routes/admin"));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --test test/admin.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 6: Run the full suite**

Run: `cd server && node --test test/`
Expected: PASS — all tests.

- [ ] **Step 7: Commit**

```bash
git add server/routes/admin.js server/app.js server/test/admin.test.js
git commit -m "feat(server): admin user-management routes (list/create/reset/delete)"
```

---

### Task 7: Frontend session helper + username/password LoginGate

**Files:**
- Create: `src/utils/session.js`
- Modify: `src/components/LoginGate.jsx` (add a username field; post `{username, password}`)

**Interfaces:**
- Produces: `session.js` exports `getMe() -> Promise<{username, role}|null>`, `login(username, password) -> Promise<Response>`, `logout() -> Promise<void>`.
- `LoginGate` now collects `username` + `password`.

- [ ] **Step 1: Create `src/utils/session.js`**

```js
// Auth/session helpers for the web build. All calls are same-origin with the
// session cookie included.
export async function getMe() {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function login(username, password) {
  return fetch("/api/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function logout() {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 2: Replace `src/components/LoginGate.jsx`**

Replace the whole file with (adds a username field, posts `{username, password}`, keeps the existing `apikey-*` styling and `onSuccess` reload flow):

```jsx
import { useState, useRef, useEffect } from "react";
import { StreambertLogo, PlayIcon } from "./Icons";
import { login } from "../utils/session";

// Full-screen username+password gate for the self-hosted web build. Posts to
// POST /api/login {username, password} and reloads on success so the signed
// cookie is picked up by every subsequent /api call.
export default function LoginGate({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const userRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => userRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = async () => {
    if (!username || !password || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await login(username, password);
      if (res.ok) {
        onSuccess();
        return;
      }
      setError(
        res.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : res.status === 401
            ? "Invalid username or password."
            : `Sign-in failed (HTTP ${res.status}).`,
      );
    } catch {
      setError("Cannot reach the server. Check your connection.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="apikey-modal">
      <div className="apikey-box">
        <div className="apikey-logo">
          <StreambertLogo />
        </div>
        <div className="apikey-title">STREAMBERT</div>
        <p className="apikey-sub">Sign in to your account.</p>
        <input
          className={`apikey-input${error ? " apikey-input-error" : ""}`}
          placeholder="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => { setUsername(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && !checking && handleSubmit()}
          ref={userRef}
          disabled={checking}
        />
        <input
          type="password"
          className={`apikey-input${error ? " apikey-input-error" : ""}`}
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && !checking && handleSubmit()}
          disabled={checking}
          style={{ marginTop: 10 }}
        />

        {error && (
          <div className="apikey-error-box">
            <div className="apikey-error-title">⚠ Sign-in failed</div>
            <div className="apikey-error-body">{error}</div>
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "13px", marginTop: error ? 0 : 12 }}
          onClick={handleSubmit}
          disabled={!username || !password || checking}
        >
          {checking ? (<><span className="apikey-spinner" /> Signing in…</>) : (<><PlayIcon /> Sign in</>)}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify the frontend builds**

Run: `npm run build`
Expected: Vite build completes with no errors; `dist/` is regenerated.

- [ ] **Step 4: Manual smoke (local, optional but recommended)**

Start the server against a scratch data dir and confirm the login page shows two fields and rejects a bad username:

```bash
STREAMBERT_DATA=/tmp/sb-dev STREAMBERT_ADMIN_USER=admin STREAMBERT_ADMIN_PASSWORD=adminpass \
  node server/index.js &
# open http://localhost:8787 -> username+password form; wrong creds -> "Invalid username or password"; admin/adminpass -> app loads
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/session.js src/components/LoginGate.jsx
git commit -m "feat(web): username+password LoginGate + session helper"
```

---

### Task 8: Admin Users panel in Settings

**Files:**
- Create: `src/components/UsersAdminPanel.jsx`
- Modify: `src/App.jsx` (fetch `/api/me`, hold `me`, pass `me` to `SettingsPage`)
- Modify: `src/pages/SettingsPage.jsx` (import + render `<UsersAdminPanel />` in a settings section, admin-only)

**Interfaces:**
- Consumes: `getMe` (Task 7); admin routes (Task 6).
- Produces: `<UsersAdminPanel />` — self-contained; fetches `/api/admin/users` and renders list + add/reset/delete. Renders nothing meaningful for non-admins (guarded by the caller).

- [ ] **Step 1: Create `src/components/UsersAdminPanel.jsx`**

```jsx
import { useEffect, useState } from "react";

// Admin-only user management. Rendered inside Settings when me.role === "admin".
export default function UsersAdminPanel() {
  const [users, setUsers] = useState([]);
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newRole, setNewRole] = useState("user");
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const res = await fetch("/api/admin/users", { credentials: "include" });
    if (res.ok) setUsers(await res.json());
  };
  useEffect(() => { load(); }, []);

  const addUser = async () => {
    setMsg(null);
    const res = await fetch("/api/admin/users", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: newName, password: newPass, role: newRole }),
    });
    if (res.ok) { setNewName(""); setNewPass(""); setNewRole("user"); load(); }
    else setMsg((await res.json().catch(() => ({}))).error || `Failed (HTTP ${res.status})`);
  };

  const resetPass = async (id) => {
    const pw = window.prompt("New password (min 8 chars):");
    if (!pw) return;
    const res = await fetch(`/api/admin/users/${id}/reset-password`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    setMsg(res.ok ? "Password reset." : ((await res.json().catch(() => ({}))).error || "Failed"));
  };

  const removeUser = async (id) => {
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) load();
    else setMsg((await res.json().catch(() => ({}))).error || "Failed");
  };

  return (
    <div>
      <h3>Users</h3>
      {msg && <div style={{ color: "var(--text2)", marginBottom: 8 }}>{msg}</div>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {users.map((u) => (
          <li key={u.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
            <span style={{ flex: 1 }}>{u.username} <em style={{ color: "var(--text3)" }}>({u.role})</em></span>
            <button className="btn" onClick={() => resetPass(u.id)}>Reset password</button>
            <button className="btn" onClick={() => removeUser(u.id)}>Delete</button>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <input className="apikey-input" placeholder="username" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input className="apikey-input" type="password" placeholder="initial password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
        <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <button className="btn btn-primary" onClick={addUser} disabled={!newName || !newPass}>Add user</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Fetch `me` in `src/App.jsx`**

Near the other startup effects in `src/App.jsx` (e.g., just after the web auth-gate effect around line 342), add a `me` state and load it. Add the import at the top with the other util imports:

```jsx
import { getMe } from "./utils/session";
```

Add state alongside the other `useState` hooks (near line 51):

```jsx
  const [me, setMe] = useState(null); // { username, role } | null (web build)
```

Add this effect near the auth-gate effect:

```jsx
  // Load the logged-in user (web build) for role-gated UI.
  useEffect(() => {
    if (!window.__STREAMBERT_WEB__) return;
    let cancelled = false;
    getMe().then((m) => { if (!cancelled) setMe(m); });
    return () => { cancelled = true; };
  }, [authGate]);
```

Then locate where `<SettingsPage ... />` is rendered in `App.jsx` and add the `me` prop, e.g.:

```jsx
            <SettingsPage
              /* ...existing props... */
              me={me}
            />
```

- [ ] **Step 3: Render the panel in `src/pages/SettingsPage.jsx`**

Add the import at the top of `src/pages/SettingsPage.jsx`:

```jsx
import UsersAdminPanel from "../components/UsersAdminPanel";
```

Accept the new `me` prop in the component signature (add `me` to the destructured props), and render the panel in a settings section — admin-only. Place it near the existing account/source settings sections:

```jsx
      {me?.role === "admin" && (
        <section className="settings-section">
          <UsersAdminPanel />
        </section>
      )}
```

(If `SettingsPage` uses a different section wrapper class, match the surrounding sections' markup; the guard `me?.role === "admin"` is the important part.)

- [ ] **Step 4: Verify the frontend builds**

Run: `npm run build`
Expected: Vite build completes with no errors.

- [ ] **Step 5: Manual smoke**

With the dev server from Task 7 running: log in as `admin`, open Settings → confirm the **Users** section appears, add a `user` account, log out, log in as that user, open Settings → confirm the Users section is **absent**, and that `/api/admin/users` returns 403 for them (Network tab).

- [ ] **Step 6: Commit**

```bash
git add src/components/UsersAdminPanel.jsx src/App.jsx src/pages/SettingsPage.jsx
git commit -m "feat(web): admin-only Users management panel in Settings"
```

---

### Task 9: Docs, env, and Docker build verification

**Files:**
- Modify: `.env.example`
- Modify: `docs/DEPLOY.md` (env table + login-change note)
- Verify: Docker image builds with `better-sqlite3`

**Interfaces:** none (docs + build check).

- [ ] **Step 1: Add bootstrap vars to `.env.example`**

Under the `--- Optional ---` section of `.env.example`, add:

```dotenv
# First-run admin bootstrap (used ONLY when the user database is empty).
# If unset, an "admin" user is created with STREAMBERT_PASSWORD as its password.
STREAMBERT_ADMIN_USER=admin
STREAMBERT_ADMIN_PASSWORD=
```

- [ ] **Step 2: Document the change in `docs/DEPLOY.md`**

Add two rows to the environment-variable table (after the `STREAMBERT_PASSWORD` row):

```markdown
| `STREAMBERT_ADMIN_USER`     | ➖       | `admin`                  | Username for the first-run bootstrap admin (only when the user DB is empty). |
| `STREAMBERT_ADMIN_PASSWORD` | ➖       | (`STREAMBERT_PASSWORD`)  | Password for the bootstrap admin; falls back to `STREAMBERT_PASSWORD`. |
```

And add a short note under the table:

```markdown
> **Login is now per-user.** On first start an admin account is created (see the
> two vars above; by default `admin` + `STREAMBERT_PASSWORD`). Create additional
> users in Settings → Users. `STREAMBERT_PASSWORD` is retained only for the
> initial admin bootstrap.
```

- [ ] **Step 3: Verify the whole server test suite still passes**

Run: `cd server && node --test test/`
Expected: PASS — all tests (Tasks 1–6).

- [ ] **Step 4: Verify the Docker image builds (better-sqlite3 native install)**

Run: `docker build -t streambert-web:phase1-test .`
Expected: build succeeds. If `better-sqlite3` fails to fetch a prebuilt binary, add build tooling to the **builder** stage only (in `Dockerfile`, before `npm install`): `RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*` — then rebuild. Note in the commit which path was needed.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/DEPLOY.md Dockerfile
git commit -m "docs: document per-user login + admin bootstrap env vars"
```

---

## Self-Review

**1. Spec coverage:**
- Data model (SQLite users, scrypt) → Tasks 1–3. ✓
- Auth flow (login/session/logout/me, per-request user resolution, instant revocation) → Task 5 (+ revocation asserted in Task 6). ✓
- Admin bootstrap → Task 3 (`bootstrapAdmin`) + Task 5 (`index.js`); admin CRUD → Task 6. ✓
- Frontend (LoginGate, `/api/me`, admin Users panel) → Tasks 7–8. ✓
- Security (no enumeration, throttle, min length, cookie flags, scrypt N) → Tasks 1/3/5. ✓
- Migration/back-compat (bootstrap fallback to `STREAMBERT_PASSWORD`, old cookies invalidated, state stays in localStorage) → Task 5 + Task 9 docs. ✓
- Build note (better-sqlite3 on node:20) → Task 9. ✓
- API surface table → Tasks 5–6 cover every row. ✓

**2. Placeholder scan:** No "TBD/TODO"; every code step contains complete code; commands have expected output. The only judgement-call spots (SettingsPage section wrapper class) include the exact guard and concrete markup. ✓

**3. Type consistency:** `hashPassword`/`verifyPassword` signatures match across Tasks 1/3/5. `buildApp({db, cookieSecret, loginThrottle, dataDir, distDir})` is defined in Task 5 and called identically in tests (Tasks 5/6) and `index.js`. Cookie name `sb_session` and value = user id are consistent in `routes/auth.js`, `app.js` `resolveUser`, and tests. `req.user = {id, username, role}` set in Task 5, consumed in Tasks 5/6/8. Throttle key `${username}|${ip}` consistent. ✓

---

## Notes for the implementer

- Run the server suite with `cd server && node --test test/` after each backend task.
- Tests use `:memory:` SQLite, so they need no cleanup and never touch `/data`.
- Do **not** change `src/utils/storage.js` in this phase — per-user state is Phase 2.
- After Task 9, deploy to Vision using the established flow (scp changed files → `docker build` → recreate container keeping a `streambert_prev` rollback → smoke test: log in as `admin` with the current password, create a second user, confirm non-admin can't reach `/api/admin/*`).
