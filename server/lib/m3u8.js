"use strict";
// Rewrite an HLS playlist so every nested URI points back through /api/proxy
// (same-origin), carrying the CDN referer. This keeps all variant/segment
// fetches server-side for BOTH player paths:
//   - hls.js (desktop/Android): its ProxyLoader sees a same-origin URL and
//     passes it through unchanged (toMediaSrc no-ops on same-origin), so there
//     is no double-proxying.
//   - native HLS (iOS Safari): there is no loader hook, so the browser fetches
//     whatever the playlist contains. Pointing it at /api/proxy means segments
//     are still fetched by the server — required because the CDN token is bound
//     to the server's IP and the browser can't send the spoofed Referer.
function rewriteM3u8(body, baseUrl, referer) {
  const toProxy = (uri) => {
    let abs;
    try {
      abs = new URL(uri, baseUrl).href;
    } catch {
      return uri;
    }
    const ref = referer ? `&referer=${encodeURIComponent(referer)}` : "";
    return `/api/proxy?url=${encodeURIComponent(abs)}${ref}`;
  };
  return body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t === "") return line;
      if (t.startsWith("#")) {
        // Rewrite any URI="..." attribute (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP).
        return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${toProxy(u)}"`);
      }
      return toProxy(t);
    })
    .join("\n");
}
module.exports = { rewriteM3u8 };
