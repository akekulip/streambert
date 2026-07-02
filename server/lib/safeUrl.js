"use strict";
// Guard for every server-side fetch of a client-named URL (SSRF defense).
function isBlockedHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // bare single-label hostnames (docker service names like "streambert-extractor")
  if (!h.includes(".") && !h.includes(":")) return true;
  // IPv4 literal ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a,b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;           // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
    if (a === 192 && b === 168) return true;           // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 loopback / ULA / link-local
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}
function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { const e = new Error("invalid url"); e.code = "BLOCKED_URL"; throw e; }
  if (u.protocol !== "http:" && u.protocol !== "https:") { const e = new Error("blocked protocol"); e.code = "BLOCKED_URL"; throw e; }
  if (isBlockedHost(u.hostname)) { const e = new Error("blocked host"); e.code = "BLOCKED_URL"; throw e; }
  return u;
}
module.exports = { isBlockedHost, assertPublicHttpUrl };
