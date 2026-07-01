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
