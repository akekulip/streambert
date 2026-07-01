"use strict";
// ── /api/files ────────────────────────────────────────────────────────────────
// Streams a completed download to the browser for in-app <video> playback.
//   GET /api/files?path=<abs path inside the downloads dir>
// Supports HTTP Range (206 partial content) so the browser can seek. Any path
// that resolves outside <DATA_DIR>/downloads is rejected (path-traversal guard).
//
// Registered with prefix "/api/files" in server/index.js; the auth preHandler
// there already gates it behind the session cookie (browsers send it for
// same-origin media requests).

const fs = require("fs");
const path = require("path");

// video + sidecar subtitle types the in-app player may request
const MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".ts": "video/mp2t",
  ".vtt": "text/vtt",
  ".srt": "application/x-subrip",
  ".ass": "text/x-ssa",
  ".ssa": "text/x-ssa",
};

// True when `child` resolves to `parent` or a path underneath it.
function isPathInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return (
    rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
  );
}

module.exports = async function (fastify) {
  const downloadsDir = path.join(fastify.config.DATA_DIR, "downloads");

  fastify.get("/", async (req, reply) => {
    const raw = req.query && req.query.path;
    if (!raw || typeof raw !== "string")
      return reply.code(400).send({ error: "missing path" });

    // Path-traversal guard: must resolve inside the downloads dir.
    if (!isPathInside(raw, downloadsDir))
      return reply.code(403).send({ error: "forbidden" });

    const filePath = path.resolve(raw);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    if (!stat.isFile()) return reply.code(404).send({ error: "not found" });

    const size = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";

    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "no-cache");

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m) {
        reply.header("Content-Range", `bytes */${size}`);
        return reply.code(416).send();
      }
      let start = m[1] === "" ? undefined : parseInt(m[1], 10);
      let end = m[2] === "" ? undefined : parseInt(m[2], 10);

      if (start === undefined) {
        // suffix range: last N bytes (bytes=-N)
        const n = end || 0;
        start = Math.max(0, size - n);
        end = size - 1;
      } else if (end === undefined || end >= size) {
        end = size - 1;
      }

      if (isNaN(start) || isNaN(end) || start > end || start >= size) {
        reply.header("Content-Range", `bytes */${size}`);
        return reply.code(416).send();
      }

      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      reply.header("Content-Length", end - start + 1);
      if (req.method === "HEAD") return reply.send();
      return reply.send(fs.createReadStream(filePath, { start, end }));
    }

    reply.header("Content-Length", size);
    if (req.method === "HEAD") return reply.send();
    return reply.send(fs.createReadStream(filePath));
  });
};
