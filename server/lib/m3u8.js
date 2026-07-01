"use strict";
// Rewrite an HLS playlist so every nested URI is an absolute URL. hls.js
// resolves relative/rooted URIs against the page origin, not the CDN, so
// without this the browser can't re-proxy VidSrc's absolute-path variants.
function rewriteM3u8(body, baseUrl) {
  return body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t === "") return line;
      if (t.startsWith("#")) {
        // Rewrite any URI="..." attribute (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP).
        return line.replace(/URI="([^"]+)"/g, (_m, u) => {
          try { return `URI="${new URL(u, baseUrl).href}"`; } catch { return _m; }
        });
      }
      try { return new URL(t, baseUrl).href; } catch { return line; }
    })
    .join("\n");
}
module.exports = { rewriteM3u8 };
