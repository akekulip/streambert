"use strict";
// AllManga (allmanga.to) anime resolver routes — web port of src/ipc/allmanga.js.
// Registered at prefix /api/allmanga (see server/index.js).
//
// Contract (must match the window.electron shim in src/web/electron-shim.js):
//   POST /resolve            -> lib.resolve(args)          (was ipc "resolve-allmanga")
//   POST /set-player-video   -> lib.setPlayerVideo(args)   (was ipc "set-player-video")
//
// Note: the POST /debug route (was ipc "debug-allmanga") has been removed —
// it was a raw SSRF / response-reflection oracle (fetched any client-supplied
// path/showId/title and echoed the response body back to the caller).
//
// Plus two support routes the returned playerUrl loads (same-origin, cookie-auth):
//   GET  /player?src=&referer=&t=   -> self-contained <video>/hls.js player page
//   GET  /hls?url=&referer=         -> Referer-spoofed, rewritten m3u8 manifest

const lib = require("../lib/allmanga");

module.exports = async function (fastify) {
  // ── resolve-allmanga ──────────────────────────────────────────────────────
  // Body: { title, seasonNumber, episodeNumber, isMovie?, translationType }
  // Returns: { ok:true, url, resolution, sourceName, isDirectMp4, referer, searchTitle? }
  //          | { ok:false, error }
  fastify.post("/resolve", async (req) => {
    const args = req.body || {};
    return lib.resolve(args);
  });

  // ── set-player-video ──────────────────────────────────────────────────────
  // Body: { url, referer, startTime } -> { playerUrl }
  fastify.post("/set-player-video", async (req) => {
    const { url, referer, startTime } = req.body || {};
    return lib.setPlayerVideo({ url, referer, startTime });
  });

  // ── player page (loaded by the renderer as an <iframe>/<webview> src) ──────
  fastify.get("/player", async (req, reply) => {
    const { src = "", referer, t } = req.query || {};
    const html = lib.buildPlayerHtml(
      src,
      referer || lib.DEFAULT_REFERER,
      Number(t) || 0,
    );
    reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Cache-Control", "no-store");
    return html;
  });

  // ── HLS manifest passthrough with Referer spoof + child-URL rewrite ────────
  fastify.get("/hls", async (req, reply) => {
    const { url, referer } = req.query || {};
    if (!url) return reply.code(400).send({ error: "missing url" });
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: "invalid url" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return reply.code(400).send({ error: "unsupported protocol" });

    try {
      const manifest = await lib.hlsManifest(url, referer || lib.DEFAULT_REFERER);
      reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*");
      return manifest;
    } catch (e) {
      if (e.code === "BLOCKED_URL")
        return reply.code(400).send({ error: "blocked url" });
      return reply.code(e.status || 502).send({ error: e.message || "hls fetch failed" });
    }
  });
};
