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
  assert.equal(r.cookies.find((c) => c.name === "sb_session"), undefined);
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
test("gate uses exact path match: pending user's /api/me?x=1 is allowed, content still 403", async () => {
  const { app } = await makeApp();
  await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "exact@x.com", password: "password1" } });
  const cookie = await loginCookie(app, "exact@x.com", "password1");
  const me = await app.inject({ method: "GET", url: "/api/me?x=1", cookies: { sb_session: cookie } });
  assert.equal(me.statusCode, 200);
  const content = await app.inject({ method: "GET", url: "/api/state/bootstrap", cookies: { sb_session: cookie } });
  assert.equal(content.statusCode, 403);
  await app.close();
});

test("register is rate-limited per IP (429 after the cap)", async () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const app = await buildApp({ db, cookieSecret: "s", loginThrottle: createLoginThrottle({ max: 2, lockoutMs: 60000 }), dataDir: os.tmpdir(), distDir: "/nonexistent" });
  const r1 = await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "r1@x.com", password: "password1" } });
  const r2 = await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "r2@x.com", password: "password1" } });
  const r3 = await app.inject({ method: "POST", url: "/api/register", payload: { identifier: "r3@x.com", password: "password1" } });
  assert.equal(r1.statusCode, 200); assert.equal(r2.statusCode, 200); assert.equal(r3.statusCode, 429);
  await app.close();
});

test("setUserStatus refuses to suspend the last admin", () => {
  const db = openDb(":memory:");
  const admin = insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  assert.throws(() => setUserStatus(db, admin.id, "disabled"), (e) => e.code === "LAST_ADMIN");
  assert.equal(db.prepare("SELECT status FROM users WHERE id=?").get(admin.id).status, "active");
});

test("setUserStatus refuses to suspend the last ACTIVE admin among multiple admins", () => {
  const db = openDb(":memory:");
  const a1 = insertUser(db, { username: "admin1", password: "adminpass", role: "admin" });
  const a2 = insertUser(db, { username: "admin2", password: "adminpass", role: "admin" });
  setUserStatus(db, a1.id, "disabled"); // ok — a2 still active
  assert.throws(() => setUserStatus(db, a2.id, "disabled"), (e) => e.code === "LAST_ADMIN");
  assert.equal(db.prepare("SELECT status FROM users WHERE id=?").get(a2.id).status, "active");
  // sanity: suspending a normal user is still fine
  const u = insertUser(db, { username: "u@x.com", password: "password1", role: "user" });
  setUserStatus(db, u.id, "disabled");
  assert.equal(db.prepare("SELECT status FROM users WHERE id=?").get(u.id).status, "disabled");
});
