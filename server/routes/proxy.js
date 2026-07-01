"use strict";
// Media stream proxy — registered at prefix /api/proxy (see server/index.js).
//
// Lets the browser play Referer/Origin-gated AllManga CDN streams (.mp4 / .ts /
// .m3u8 segments) that it could never fetch directly. Server-side we may set the
// otherwise browser-forbidden Referer/Origin headers.
//
//   GET /api/proxy?url=<enc>[&referer=<enc>][&origin=<enc>][&ua=<enc>]
//
// Behaviour:
//   - forwards the client Range header upstream (seek / partial content),
//   - passes through status + Content-Range / Accept-Ranges / Content-Length /
//     Content-Type (and Last-Modified / ETag) from the upstream response,
//   - spoofs Referer / Origin / User-Agent upstream,
//   - follows redirects server-side (so signed-CDN 302s keep the spoofed headers),
//   - sets permissive CORS headers and streams the body.

const https = require("https");
const http = require("http");

// Reuse TCP+TLS connections across requests. HLS playback fetches many
// segments/manifests from the same CDN through this proxy; without keep-alive
// each one paid a fresh connect+handshake.
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 64 });

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";
const DEFAULT_REFERER = "https://allmanga.to";
const MAX_REDIRECTS = 5;

// Makes the upstream request (following redirects) and resolves with the final
// http.IncomingMessage response stream.
function requestUpstream(targetUrl, opts, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > MAX_REDIRECTS) return reject(new Error("too many redirects"));
    let u;
    try {
      u = new URL(targetUrl);
    } catch {
      return reject(new Error("invalid url"));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return reject(new Error("unsupported protocol"));

    const lib = u.protocol === "https:" ? https : http;
    const headers = {
      "User-Agent": opts.ua,
      Referer: opts.referer,
      Accept: "*/*",
    };
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.range) headers.Range = opts.range;

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: "GET",
        headers,
        agent: u.protocol === "https:" ? keepAliveHttps : keepAliveHttp,
      },
      (res) => {
        // Follow redirects, preserving the spoofed headers + Range.
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const loc = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, targetUrl).href;
          res.resume();
          requestUpstream(loc, opts, hops + 1).then(resolve, reject);
          return;
        }
        resolve(res);
      },
    );
    req.on("error", reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
];

module.exports = async function (fastify) {
  // CORS preflight (same-origin usage needs none, but keep the proxy permissive).
  fastify.options("/", async (_req, reply) => {
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
      .header("Access-Control-Allow-Headers", "Range")
      .code(204)
      .send();
  });

  fastify.get("/", async (req, reply) => {
    const { url, referer, origin, ua } = req.query || {};
    if (!url) return reply.code(400).send({ error: "missing url" });

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: "invalid url" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return reply.code(400).send({ error: "unsupported protocol" });

    let upstream;
    try {
      upstream = await requestUpstream(url, {
        range: req.headers.range || undefined,
        referer: referer || DEFAULT_REFERER,
        origin: origin || undefined,
        ua: ua || DEFAULT_UA,
      });
    } catch (e) {
      return reply.code(502).send({ error: e.message || "proxy failed" });
    }

    // Pass through the upstream status (200 / 206 partial) + selected headers.
    for (const h of PASS_HEADERS) {
      if (upstream.headers[h]) reply.header(h, upstream.headers[h]);
    }
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", "Range")
      .header(
        "Access-Control-Expose-Headers",
        "Content-Range, Accept-Ranges, Content-Length, Content-Type",
      )
      .header("Cache-Control", "no-store")
      .code(upstream.statusCode || 502);

    // Clean up the upstream socket if the client disconnects (seek / close).
    reply.raw.on("close", () => {
      try {
        upstream.destroy();
      } catch {
        /* ignore */
      }
    });

    return reply.send(upstream);
  });
};
