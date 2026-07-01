"use strict";
// ── /api/downloads ────────────────────────────────────────────────────────────
// Web port of src/ipc/downloads.js. Owns the download queue, spawns the vid-dl
// CLI, and streams progress to the browser via fastify.broadcast(...) →
// "download-progress" (the shim maps it to onDownloadProgress). Registered with
// prefix "/api/downloads" in server/index.js.
//
// Contract (see src/web/electron-shim.js):
//   POST /check       {folder}                         -> {exists, reason?, binaryPath?}
//   POST /            {m3u8Url,name,...,subtitles}      -> {ok, id} | {ok:false, error}
//   GET  /                                              -> Download[]
//   POST /delete      {id, filePath}                    -> {ok}
//   POST /scan        {path}                            -> {filePath,name,size,ext}[]
//   POST /file-exists {path}                            -> boolean
//   GET  /size                                          -> {bytes}
//   POST /delete-all                                    -> {ok, deleted, errors}
//   POST /duration    {filePath}                        -> {ok, duration?}
//   POST /prune-subs  {downloadId}                      -> {ok, subtitlePaths}

const { createDownloadManager } = require("../lib/downloads");

module.exports = async function (fastify) {
  const downloaderPath = process.env.STREAMBERT_DOWNLOADER || "vid-dl";

  const manager = createDownloadManager({
    dataDir: fastify.config.DATA_DIR,
    downloaderPath,
    // fastify.broadcast is decorated by server/events.js.
    broadcast: (channel, payload) => fastify.broadcast(channel, payload),
  });

  // Expose the manager so sibling plugins (e.g. /api/files) can reuse the
  // resolved downloads directory without re-deriving it.
  fastify.decorate("downloads", manager);

  // POST /check — downloader availability (env-driven; `folder` ignored).
  fastify.post("/check", async () => manager.checkDownloader());

  // POST / — start a download.
  fastify.post("/", async (req) => manager.runDownload(req.body || {}));

  // GET / — full registry.
  fastify.get("/", async () => manager.getDownloads());

  // POST /delete — remove one download (file + subtitles + registry entry).
  fastify.post("/delete", async (req) =>
    manager.deleteDownload(req.body || {}),
  );

  // POST /scan — list playable video files on the server.
  fastify.post("/scan", async (req) =>
    manager.scanDirectory((req.body || {}).path),
  );

  // POST /file-exists — existence check, constrained to the downloads dir.
  fastify.post("/file-exists", async (req) =>
    manager.fileExists((req.body || {}).path),
  );

  // GET /size — total bytes of tracked files.
  fastify.get("/size", async () => manager.getDownloadsSize());

  // POST /delete-all — wipe every download + its files.
  fastify.post("/delete-all", async () => manager.deleteAllDownloads());

  // POST /duration — ffprobe the file duration in seconds.
  fastify.post("/duration", async (req) =>
    manager.getVideoDuration((req.body || {}).filePath),
  );

  // POST /prune-subs — drop subtitle paths that no longer exist on disk.
  fastify.post("/prune-subs", async (req) =>
    manager.pruneSubtitlePaths((req.body || {}).downloadId),
  );
};
