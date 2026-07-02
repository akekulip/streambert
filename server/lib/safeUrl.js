"use strict";
// Guard for every server-side fetch of a client-named URL (SSRF defense).
const dns = require("dns").promises;

function isBlockedHost(hostname) {
  if (!hostname) return true;
  // Strip IPv6 brackets and a trailing FQDN dot before any other check, and
  // unwrap IPv4-mapped IPv6 literals (::ffff:1.2.3.4) to their embedded IPv4
  // so the range checks below can't be bypassed by either form. WHATWG URL
  // parsing (new URL().hostname) canonicalizes the mapped address to hex
  // groups (::ffff:7f00:1), so both the dotted and hex forms are handled.
  let host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const v4mappedDotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4mappedDotted) {
    host = v4mappedDotted[1];
  } else if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    host = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  // bare single-label hostnames (docker service names like "streambert-extractor")
  if (!host.includes(".") && !host.includes(":")) return true;
  // IPv4 literal ranges
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a,b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;           // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
    if (a === 192 && b === 168) return true;           // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 loopback / ULA / link-local
  if (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}
function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { const e = new Error("invalid url"); e.code = "BLOCKED_URL"; throw e; }
  if (u.protocol !== "http:" && u.protocol !== "https:") { const e = new Error("blocked protocol"); e.code = "BLOCKED_URL"; throw e; }
  if (isBlockedHost(u.hostname)) { const e = new Error("blocked host"); e.code = "BLOCKED_URL"; throw e; }
  return u;
}

// Resolves the hostname and rejects if ANY resolved address is blocked —
// catches a public-looking hostname that consistently resolves to a
// private/internal IP (string checks on the hostname alone can't catch this,
// e.g. a public DNS name like 127.0.0.1.nip.io). This is a resolve-time check
// only: it does not pin the resolved IP for the subsequent connection, so a
// true DNS-rebinding race (attacker flips the answer between this check and
// the connect that follows) is a known residual risk, not one this closes.
async function assertResolvedPublic(u) {
  assertPublicHttpUrl(u.href);
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try { addrs = await dns.lookup(hostname, { all: true }); }
  catch { const e = new Error("dns fail"); e.code = "BLOCKED_URL"; throw e; }
  for (const a of addrs) {
    if (isBlockedHost(a.address)) { const e = new Error("resolves to blocked ip"); e.code = "BLOCKED_URL"; throw e; }
  }
}

// Fetches a client-named URL, following redirects MANUALLY so each hop is
// re-validated (string + resolve-time IP) before it's followed — global
// fetch()'s default redirect:"follow" would otherwise let a public URL 302
// straight to an internal address, bypassing the guard entirely.
async function safeFetch(rawUrl, options = {}, ms = 15000) {
  let u = assertPublicHttpUrl(rawUrl);
  for (let hop = 0; hop < 6; hop++) {
    await assertResolvedPublic(u);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    let res;
    try { res = await fetch(u.href, { ...options, redirect: "manual", signal: controller.signal }); }
    finally { clearTimeout(t); }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = assertPublicHttpUrl(new URL(res.headers.get("location"), u.href).href);
      continue;
    }
    return res;
  }
  const e = new Error("too many redirects"); e.code = "BLOCKED_URL"; throw e;
}

module.exports = { isBlockedHost, assertPublicHttpUrl, assertResolvedPublic, safeFetch };
