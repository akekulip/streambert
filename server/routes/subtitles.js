"use strict";
// ── Routes: /api/subtitles ────────────────────────────────────────────────────
// Port of the subtitle IPC handlers (src/ipc/subtitles.js) to Fastify.
// Relative routes (prefixed with /api/subtitles by server/index.js):
//   POST /search   -> searchSubtitles({ tmdbId, mediaType, season, episode,
//                                       languages, subdlApiKey, wyzieApiKey })
//   POST /url      -> getSubtitleUrl({ fileId })
//   POST /download -> downloadSubtitlesForFile({ filePath, selectedSubs })
//   POST /delete   -> deleteSubtitleFile({ downloadId, subtitlePath })
//
// API keys (SubDL / Wyzie) arrive in the POST body exactly as the Electron
// renderer sent them over IPC — the renderer reads them from the secure store
// client-side and passes them as args. This route does not touch the secure
// store itself.

const path = require("path");
const fs = require("fs");
const subs = require("../lib/subtitles");

// Resolve the downloads registry store used for merging/removing subtitlePaths.
// Preference order so this file never hard-depends on another agent's module:
//   1. fastify.downloadsStore decorator ({ getDownloads, saveDownloads })
//   2. an in-process ../lib/downloads that cleanly exports those functions
//   3. fallback: read/write DATA_DIR/downloads.json directly (Electron format).
// The fallback reads fresh on every call so it never clobbers the downloads
// module's persisted state; the array returned by getDownloads() is the same
// reference saveDownloads() persists, matching the Electron store contract.
function resolveDownloadsStore(fastify) {
  const ds = fastify.downloadsStore;
  if (
    ds &&
    typeof ds.getDownloads === "function" &&
    typeof ds.saveDownloads === "function"
  ) {
    return ds;
  }

  try {
    const mod = require("../lib/downloads");
    if (
      mod &&
      typeof mod.getDownloads === "function" &&
      typeof mod.saveDownloads === "function"
    ) {
      return { getDownloads: mod.getDownloads, saveDownloads: mod.saveDownloads };
    }
  } catch (e) {
    if (!e || e.code !== "MODULE_NOT_FOUND") throw e;
  }

  const file = path.join(fastify.config.DATA_DIR, "downloads.json");
  let cache = [];
  return {
    getDownloads() {
      try {
        cache = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Array.isArray(cache)) cache = [];
      } catch {
        cache = [];
      }
      return cache;
    },
    saveDownloads() {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(cache, null, 2));
      } catch {
        /* best-effort persistence */
      }
    },
  };
}

module.exports = async function (fastify) {
  const store = resolveDownloadsStore(fastify);
  const dataDir = fastify.config.DATA_DIR;

  fastify.post("/search", async (req) =>
    subs.searchSubtitles(req.body || {}),
  );

  fastify.post("/url", async (req) =>
    subs.getSubtitleUrl(req.body || {}, { dataDir }),
  );

  // WebVTT for the browser player's <track> (SRT→VTT converted, served over
  // HTTP so a same-origin <track src> can load it — file:// / .srt can't).
  fastify.get("/vtt", async (req, reply) => {
    const fileId = (req.query || {}).fileId;
    if (!fileId) return reply.code(400).send({ error: "fileId required" });
    const r = await subs.getSubtitleVtt({ fileId });
    if (!r.ok) return reply.code(502).send({ error: r.error });
    return reply
      .header("Content-Type", "text/vtt; charset=utf-8")
      .header("Cache-Control", "private, max-age=3600")
      .send(r.vtt);
  });

  fastify.post("/download", async (req) =>
    subs.downloadSubtitlesForFile(req.body || {}, { store, dataDir }),
  );

  fastify.post("/delete", async (req) =>
    subs.deleteSubtitleFile(req.body || {}, { store, dataDir }),
  );
};
