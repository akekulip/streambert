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
