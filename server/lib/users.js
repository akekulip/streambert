"use strict";
const { hashPassword, verifyPassword } = require("./passwords");

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
    // better-sqlite3 exposes a structured code; fall back to the message text.
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || String(e.message).includes("UNIQUE")) {
      const err = new Error("username taken");
      err.code = "DUP";
      throw err;
    }
    throw e;
  }
  return { id: info.lastInsertRowid, username: uname, role, status, created_at };
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
  return db.prepare("SELECT id, username, role, status, created_at FROM users ORDER BY id").all();
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

const VALID_STATUS = ["pending", "active", "disabled"];
function registerUser(db, { identifier, password }) {
  if (!isValidIdentifier(identifier)) { const e = new Error("invalid email or phone"); e.code = "BADINPUT"; throw e; }
  if (!isValidPassword(password)) { const e = new Error("invalid password"); e.code = "BADINPUT"; throw e; }
  return insertUser(db, { username: identifier, password, role: "user", status: "pending" });
}
function setUserStatus(db, id, status) {
  if (!VALID_STATUS.includes(status)) throw new Error("invalid status");
  if (status === "disabled") {
    const user = getUserById(db, id);
    if (user && user.role === "admin" && user.status === "active") {
      const activeAdmins = db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'")
        .get().n;
      if (activeAdmins <= 1) {
        const err = new Error("cannot suspend the last active admin");
        err.code = "LAST_ADMIN";
        throw err;
      }
    }
  }
  const info = db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
  if (info.changes === 0) throw new Error("no such user");
}

module.exports = {
  insertUser, createUser, getUserByUsername, getUserById, listUsers,
  countAdmins, resetPassword, deleteUser, bootstrapAdmin, verifyPassword,
  isValidIdentifier, isValidPassword, registerUser, setUserStatus,
};
