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

  // POST / — start a download. Scoped to the caller (I1: entry.userId), and
  // 429s once MAX_CONCURRENT_DOWNLOADS spawns are already in flight.
  fastify.post("/", async (req, reply) => {
    const result = manager.runDownload(req.body || {}, req.user);
    if (!result.ok && result.code === "TOO_MANY") reply.code(429);
    return result;
  });

  // GET / — registry, scoped to the caller (admins see everyone's).
  fastify.get("/", async (req) => manager.getDownloads(req.user));

  // POST /delete — remove one download (file + subtitles + registry entry).
  // 403s if the target belongs to another (non-admin) user.
  fastify.post("/delete", async (req, reply) => {
    const result = manager.deleteDownload(req.body || {}, req.user);
    if (!result.ok && result.code === "FORBIDDEN") reply.code(403);
    return result;
  });

  // POST /scan — list playable video files on the server, scoped to the caller.
  fastify.post("/scan", async (req) =>
    manager.scanDirectory((req.body || {}).path, req.user),
  );

  // POST /file-exists — existence check, constrained to the downloads dir and
  // to the caller's own tracked downloads.
  fastify.post("/file-exists", async (req) =>
    manager.fileExists((req.body || {}).path, req.user),
  );

  // GET /size — total bytes of the caller's own tracked files (admins get
  // everyone's).
  fastify.get("/size", async (req) => manager.getDownloadsSize(req.user));

  // POST /delete-all — wipe the caller's own downloads + their files (admins
  // wipe everyone's).
  fastify.post("/delete-all", async (req) =>
    manager.deleteAllDownloads(req.user),
  );

  // POST /duration — ffprobe the file duration in seconds, scoped to the caller.
  fastify.post("/duration", async (req) =>
    manager.getVideoDuration((req.body || {}).filePath, req.user),
  );

  // POST /prune-subs — drop subtitle paths that no longer exist on disk.
  // 403s if the target belongs to another (non-admin) user.
  fastify.post("/prune-subs", async (req, reply) => {
    const result = manager.pruneSubtitlePaths(
      (req.body || {}).downloadId,
      req.user,
    );
    if (!result.ok && result.code === "FORBIDDEN") reply.code(403);
    return result;
  });
};
