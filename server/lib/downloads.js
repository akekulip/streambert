"use strict";
// ── Download manager (web port of src/ipc/downloads.js) ───────────────────────
// De-Electron-ified: no app / ipcMain / shell / dialog / session. Instead of
// webContents.send("download-progress", ...) it calls an injected
// broadcast(channel, payload) with channel "download-progress" (same payload).
//
// All paths are server-controlled:
//   • downloads land in   <dataDir>/downloads
//   • the registry is     <dataDir>/downloads.json
// The downloader binary is resolved from `downloaderPath` (env
// STREAMBERT_DOWNLOADER, default "vid-dl"). Client-supplied binaryPath /
// downloadPath from the old Electron IPC are intentionally ignored — the server
// never spawns an arbitrary client-named binary or writes outside its data dir.

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { safeFetch } = require("./safeUrl");

const VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts"];

// True when `child` resolves to `parent` or a path underneath it.
function isPathInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return (
    rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
  );
}

function humanBytes(bytes) {
  return bytes > 1e9
    ? (bytes / 1e9).toFixed(2) + " GB"
    : bytes > 1e6
      ? (bytes / 1e6).toFixed(1) + " MB"
      : bytes > 1e3
        ? (bytes / 1e3).toFixed(1) + " KB"
        : bytes + " B";
}

const MAX_SUB_BYTES = 10 * 1024 * 1024; // subtitles are tiny; 10 MB is generous
const MAX_SUBTITLES = 25; // bounds total concurrent subtitle fetches per download

// Reads a web ReadableStream (e.g. a fetch Response's `body`) up to
// `maxBytes`. Returns the concatenated Buffer if the stream stays within the
// cap, or null if it produced more than maxBytes (the stream is cancelled as
// soon as the cap is exceeded, so the rest of the body is never buffered).
// A null/undefined stream (e.g. an empty response body) reads as empty.
async function readCapped(stream, maxBytes) {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// ── Subtitle file downloader (used during run-download completion) ─────────────
// http(s) only — no `file:` branch (that was an arbitrary local-file read).
// Goes through safeFetch, which rejects private/loopback/link-local targets
// and re-validates every redirect hop (SSRF guard). Rejects on any blocked or
// non-http(s) URL; resolves false on a non-2xx response, an over-cap
// Content-Length, or a body that exceeds `maxBytes` while streaming (read via
// `readCapped` so the response is never buffered whole in RAM before the
// check); resolves true once the body is written to destPath. On a write
// failure, the partial file is unlinked before the error propagates.
async function downloadSubtitleFile(url, destPath, maxBytes = MAX_SUB_BYTES) {
  const res = await safeFetch(url, {}, 20000);
  if (!res.ok) return false;
  const cl = Number(res.headers.get("content-length"));
  if (cl && cl > maxBytes) return false;
  const buf = await readCapped(res.body, maxBytes);
  if (buf === null) return false;
  try {
    fs.writeFileSync(destPath, buf);
  } catch (e) {
    try {
      fs.unlinkSync(destPath);
    } catch {}
    throw e;
  }
  return true;
}

// ── Manager factory ────────────────────────────────────────────────────────────
function createDownloadManager({ dataDir, downloaderPath, broadcast }) {
  const downloadsDir = path.join(dataDir, "downloads");
  const downloadsFile = path.join(dataDir, "downloads.json");
  const ffprobeEnv = process.env.STREAMBERT_FFPROBE || null;
  const ffmpegEnv = process.env.STREAMBERT_FFMPEG || null;

  let downloads = [];
  const activeProcs = new Map(); // download id -> child process

  const send =
    typeof broadcast === "function" ? broadcast : () => {};
  const sendProgress = (update) => {
    try {
      send("download-progress", update);
    } catch {}
  };

  const ensureDownloadsDir = () => {
    try {
      fs.mkdirSync(downloadsDir, { recursive: true });
    } catch {}
  };

  // ── Registry persistence ─────────────────────────────────────────────────
  function loadDownloads() {
    try {
      const raw = fs.readFileSync(downloadsFile, "utf8");
      const parsed = JSON.parse(raw);
      const seen = new Map();
      const sorted = [...parsed].sort(
        (a, b) =>
          (b.completedAt || b.startedAt || 0) -
          (a.completedAt || a.startedAt || 0),
      );
      for (const d of sorted) {
        const key =
          d.tmdbId && d.mediaType
            ? `${d.tmdbId}|${d.mediaType}|${d.season ?? ""}|${d.episode ?? ""}`
            : d.id;
        if (!seen.has(key)) seen.set(key, d);
      }
      downloads = [...seen.values()];
    } catch {
      downloads = [];
    }
  }

  function saveDownloads() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const toSave = downloads.filter(
        (d) => d.status !== "downloading" && d.status !== "error",
      );
      fs.writeFileSync(downloadsFile, JSON.stringify(toSave, null, 2));
    } catch {}
  }

  function cleanupTempFiles(dir) {
    if (!dir) return;
    const TEMP_PATTERNS = [
      /\.part$/,
      /\.part\.\d+$/,
      /\.part\.tmp$/,
      /\.tmp$/,
      /\.ytdl$/,
      /\.part-Frag\d+$/,
    ];
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (TEMP_PATTERNS.some((p) => p.test(entry))) {
          try {
            fs.unlinkSync(path.join(dir, entry));
          } catch {}
        }
      }
    } catch {}
  }

  function killAll() {
    for (const [id, proc] of activeProcs.entries()) {
      try {
        proc.kill("SIGKILL");
      } catch {}
      const idx = downloads.findIndex((d) => d.id === id);
      if (idx !== -1) {
        downloads[idx].status = "error";
        downloads[idx].lastMessage = "Cancelled on exit";
      }
      activeProcs.delete(id);
    }
    cleanupTempFiles(downloadsDir);
    saveDownloads();
  }

  // ── Downloader binary resolution ─────────────────────────────────────────
  // Absolute path -> must be an existing file. Bare name -> resolve on PATH.
  function resolveDownloaderBinary() {
    const configured = downloaderPath;
    if (!configured) return null;
    if (path.isAbsolute(configured)) {
      try {
        return fs.statSync(configured).isFile() ? configured : null;
      } catch {
        return null;
      }
    }
    try {
      const which = spawnSync(
        process.platform === "win32" ? "where" : "which",
        [configured],
        { encoding: "utf8" },
      );
      if (which.status === 0 && which.stdout.trim()) {
        return which.stdout.trim().split(/\r?\n/)[0].trim();
      }
    } catch {}
    return null;
  }

  // Web analogue of "check-downloader". The desktop scanned a user folder; on
  // the server the binary is env-driven, so `folder` is ignored.
  function checkDownloader() {
    const bin = resolveDownloaderBinary();
    if (!bin) {
      return {
        exists: false,
        reason: downloaderPath
          ? "downloader_not_found"
          : "downloader_not_configured",
        binaryPath: null,
      };
    }
    return { exists: true, binaryPath: bin };
  }

  // ── Start a download ──────────────────────────────────────────────────────
  function runDownload(opts) {
    const {
      m3u8Url,
      name,
      mediaId,
      mediaType,
      season,
      episode,
      posterPath,
      tmdbId,
      subtitles,
    } = opts || {};

    const binaryPath = resolveDownloaderBinary();
    if (!binaryPath) {
      return {
        ok: false,
        error:
          "Downloader binary not available. Set STREAMBERT_DOWNLOADER to the vid-dl CLI path (or install it on PATH).",
      };
    }
    if (!m3u8Url) return { ok: false, error: "Missing m3u8Url" };

    // Server owns the output directory — never trust a client-supplied path.
    const downloadPath = downloadsDir;

    try {
      ensureDownloadsDir();
      const id = crypto.randomUUID();
      const logPath = path.join(os.tmpdir(), `streambert_dl_${id}.log`);

      const entry = {
        id,
        name,
        m3u8Url,
        downloadPath,
        filePath: null,
        status: "downloading",
        progress: 0,
        speed: "",
        size: "",
        totalFragments: 0,
        completedFragments: 0,
        lastMessage: "Starting…",
        startedAt: Date.now(),
        completedAt: null,
        mediaId: mediaId || null,
        mediaType: mediaType || null,
        season: season || null,
        episode: episode || null,
        posterPath: posterPath || null,
        tmdbId: tmdbId || mediaId || null,
        // Cap upfront: subtitles is client-supplied and otherwise unbounded,
        // and every entry here is fetched in parallel below (Promise.all).
        subtitles: (Array.isArray(subtitles) ? subtitles : []).slice(
          0,
          MAX_SUBTITLES,
        ),
        subtitlePaths: [],
        logPath,
      };

      try {
        fs.writeFileSync(
          logPath,
          `Streambert Download Log\nName: ${name}\nURL: ${m3u8Url}\nStarted: ${new Date().toISOString()}\n${"─".repeat(60)}\n`,
          "utf8",
        );
      } catch {}

      downloads.push(entry);

      // Remove stale entries for the same media.
      const isSameMedia = (d) =>
        d.id !== id &&
        d.tmdbId &&
        d.tmdbId === entry.tmdbId &&
        d.mediaType === entry.mediaType &&
        String(d.season ?? "") === String(entry.season ?? "") &&
        String(d.episode ?? "") === String(entry.episode ?? "");
      downloads = downloads.filter((d) => !isSameMedia(d));

      const args = [
        "--cli",
        m3u8Url,
        "-f",
        "mp4 (with Audio)",
        "-r",
        "best",
        "-b",
        "320",
        "-n",
        name,
        "-d",
        downloadPath,
      ];

      const proc = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeProcs.set(id, proc);

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const idx = downloads.findIndex((d) => d.id === id);
        if (idx === -1) return;

        const update = {};

        const fragMatch = trimmed.match(/\(frag\s+(\d+)\/(\d+)\)/);
        if (fragMatch) {
          const currentFrag = parseInt(fragMatch[1]);
          const total = parseInt(fragMatch[2]);
          update.completedFragments = currentFrag;
          update.totalFragments = total;
          update.progress = Math.min(
            99,
            Math.round((currentFrag / total) * 100),
          );
          update.lastMessage = `Fragment ${currentFrag} / ${total}`;
        }

        if (!fragMatch && !downloads[idx].totalFragments) {
          const dlPctMatch = trimmed.match(
            /^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*(?:[KMGT]i?B|B))/i,
          );
          if (dlPctMatch) {
            const pct = parseFloat(dlPctMatch[1]);
            update.progress = Math.min(99, Math.round(pct));
            update.size = dlPctMatch[2].trim();
            const spMatch = trimmed.match(
              /\bat\s+([\d.]+\s*(?:[KMGT]i?B|B)\/s)/i,
            );
            if (spMatch) update.speed = spMatch[1].trim();
            update.lastMessage = `${Math.round(pct)}% of ${update.size}`;
          }
        }

        const durationMatch = trimmed.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (durationMatch) {
          const totalSecs =
            parseInt(durationMatch[1]) * 3600 +
            parseInt(durationMatch[2]) * 60 +
            parseFloat(durationMatch[3]);
          if (totalSecs > 0) downloads[idx]._ffmpegTotalSecs = totalSecs;
          return;
        }

        const ffmpegMatch = trimmed.match(
          /size=\s*([\d.]+\s*\w+)\s+time=(\d+):(\d+):([\d.]+)/i,
        );
        if (ffmpegMatch) {
          const elapsedSecs =
            parseInt(ffmpegMatch[2]) * 3600 +
            parseInt(ffmpegMatch[3]) * 60 +
            parseFloat(ffmpegMatch[4]);
          const totalSecs = downloads[idx]._ffmpegTotalSecs || 0;
          if (totalSecs > 0) {
            update.progress = Math.min(
              99,
              Math.round((elapsedSecs / totalSecs) * 100),
            );
          }
          const rawSize = ffmpegMatch[1].trim();
          const kbMatch = rawSize.match(/([\d.]+)\s*kB/i);
          if (kbMatch) {
            const mb = parseFloat(kbMatch[1]) / 1024;
            update.size =
              mb >= 1024
                ? `${(mb / 1024).toFixed(1)} GiB`
                : `${mb.toFixed(1)} MiB`;
          } else {
            update.size = rawSize;
          }
          const speedXMatch = trimmed.match(/speed=\s*([\d.]+)x/i);
          if (speedXMatch) update.speed = `${speedXMatch[1]}x`;
          update.lastMessage = `Processing… ${update.size}${update.speed ? ` at ${update.speed}` : ""}`;
        }

        const retryMatch =
          trimmed.match(/Retrying\s+\(\d+\/\d+\)/i) ||
          trimmed.match(/Got error:.*timed?\s*out/i) ||
          trimmed.match(/Read timed? out/i);
        if (retryMatch) {
          update.speed = "0 MB/s";
          const retryNumMatch = trimmed.match(/Retrying\s+\((\d+)\/(\d+)\)/i);
          update.lastMessage = retryNumMatch
            ? `Retrying… (${retryNumMatch[1]}/${retryNumMatch[2]})`
            : "Retrying…";
          downloads[idx] = { ...downloads[idx], ...update };
          sendProgress({ id, ...update, status: downloads[idx].status });
          return;
        }

        const speedMatch = trimmed.match(
          /\bat\s+([\d.]+\s*(?:[KMGT]i?B|B)\/s)/i,
        );
        if (speedMatch) update.speed = speedMatch[1].trim();

        const sizeMatch = trimmed.match(
          /\bof\s+~?\s*([\d.]+\s*(?:[KMGT]i?B|B))\b/i,
        );
        if (sizeMatch) update.size = sizeMatch[1].trim();

        const fragTotalMatch = trimmed.match(/Total fragments:\s+(\d+)/);
        if (fragTotalMatch) {
          const total = parseInt(fragTotalMatch[1]);
          const u = {
            totalFragments: total,
            completedFragments: 0,
            lastMessage: `HLS: ${total} fragments`,
          };
          downloads[idx] = { ...downloads[idx], ...u };
          sendProgress({ id, ...u, status: downloads[idx].status });
          return;
        }

        const destMatch = trimmed.match(/^\[download\] Destination:\s+(.+)/);
        if (destMatch) {
          const u = {
            filePath: destMatch[1].trim(),
            lastMessage: "Downloading…",
          };
          downloads[idx] = { ...downloads[idx], ...u };
          sendProgress({ id, ...u, status: downloads[idx].status });
          return;
        }

        const mergeMatch = trimmed.match(
          /\[Merger\] Merging formats into "(.+)"/,
        );
        if (mergeMatch) {
          const u = {
            filePath: mergeMatch[1].trim(),
            lastMessage: "Merging…",
            progress: 99,
          };
          downloads[idx] = { ...downloads[idx], ...u };
          sendProgress({ id, ...u, status: downloads[idx].status });
          return;
        }

        const SUPPRESS_PATTERNS = [
          /Sleeping\s+[\d.]+\s+seconds/i,
          /^\[yt-dlp\s+DEBUG\]/i,
          /^\[debug\]/i,
        ];
        if (Object.keys(update).length === 0) {
          const suppress =
            downloads[idx].lastMessage.startsWith("Fragment") ||
            downloads[idx].lastMessage.startsWith("Retrying") ||
            SUPPRESS_PATTERNS.some((p) => p.test(trimmed));
          if (!suppress) update.lastMessage = trimmed;
        }

        if (Object.keys(update).length > 0) {
          downloads[idx] = { ...downloads[idx], ...update };
          sendProgress({ id, ...update, status: downloads[idx].status });
        }
      };

      let buf = "";
      let stderrBuf = "";

      const appendLog = (line) => {
        try {
          fs.appendFileSync(logPath, line + "\n", "utf8");
        } catch {}
      };

      proc.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split(/\r\n|\r|\n/);
        buf = lines.pop();
        lines.forEach((l) => {
          appendLog(l);
          handleLine(l);
        });
      });
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        text.split(/\r\n|\r|\n/).forEach((l) => {
          appendLog(l);
          handleLine(l);
        });
      });

      proc.on("error", (err) => {
        activeProcs.delete(id);
        const idx = downloads.findIndex((d) => d.id === id);
        if (idx === -1) return;
        const msg =
          err.code === "EACCES"
            ? `Permission denied, binary is not executable: ${binaryPath}`
            : err.code === "ENOENT"
              ? `Binary not found: ${binaryPath}`
              : `Failed to start downloader: ${err.message}`;
        downloads[idx].status = "error";
        downloads[idx].completedAt = Date.now();
        downloads[idx].lastMessage = msg;
        appendLog(msg);
        sendProgress({ id, status: "error", lastMessage: msg });
      });

      proc.on("close", (code) => {
        activeProcs.delete(id);
        if (buf.trim()) {
          appendLog(buf.trim());
          handleLine(buf.trim());
        }
        const idx = downloads.findIndex((d) => d.id === id);
        if (idx === -1) return;

        const status = code === 0 ? "completed" : "error";
        downloads[idx].status = status;
        downloads[idx].completedAt = Date.now();
        if (code === 0) {
          downloads[idx].progress = 100;
          downloads[idx].logPath = null;
          try {
            fs.unlinkSync(logPath);
          } catch {}
        } else {
          try {
            fs.appendFileSync(
              logPath,
              `${"─".repeat(60)}\nFailed: exit code ${code}\nFinished: ${new Date().toISOString()}\n`,
              "utf8",
            );
          } catch {}
          const errorLine =
            stderrBuf
              .split(/\r\n|\r|\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .reverse()
              .find((l) => /error|failed|unable|cannot|denied/i.test(l)) || "";
          const prev = downloads[idx].lastMessage || "";
          const base = errorLine || prev;
          downloads[idx].lastMessage = base
            ? `${base} (exit ${code})`
            : `Download failed (exit code ${code})`;
        }

        if (code === 0 && !downloads[idx].filePath) {
          try {
            const match = fs
              .readdirSync(downloadPath)
              .filter((f) => VIDEO_EXTS.some((e) => f.toLowerCase().endsWith(e)))
              .map((f) => ({
                f,
                mtime: fs.statSync(path.join(downloadPath, f)).mtimeMs,
              }))
              .sort((a, b) => b.mtime - a.mtime)[0];
            if (match) downloads[idx].filePath = path.join(downloadPath, match.f);
          } catch {}
        }

        if (code === 0 && downloads[idx].filePath) {
          try {
            const ext = path.extname(downloads[idx].filePath) || ".mp4";
            const safeName = String(name || "")
              .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
              .replace(/\s+/g, " ")
              .trim();
            if (safeName) {
              const newPath = path.join(downloadPath, safeName + ext);
              if (newPath !== downloads[idx].filePath) {
                fs.renameSync(downloads[idx].filePath, newPath);
                downloads[idx].filePath = newPath;
              }
            }
          } catch {}
        }

        if (downloads[idx].filePath) {
          try {
            downloads[idx].size = humanBytes(
              fs.statSync(downloads[idx].filePath).size,
            );
          } catch {}
        }

        if (
          code === 0 &&
          downloads[idx].subtitles?.length > 0 &&
          downloads[idx].filePath
        ) {
          const videoBase = downloads[idx].filePath.replace(/\.[^.]+$/, "");
          const langCounter = {};
          const KNOWN_SUB_EXTS = [
            ".vtt",
            ".srt",
            ".ass",
            ".ssa",
            ".sub",
            ".idx",
          ];
          const subPromises = downloads[idx].subtitles.map(
            ({ url, lang, name: subName, file_id }) => {
              const urlClean = url.split("?")[0].split("#")[0];
              const urlExt = path
                .extname(urlClean)
                .toLowerCase()
                .replace(/[^a-z0-9.]/g, "");
              const nameExt = subName
                ? path.extname(subName).toLowerCase().replace(/[^a-z0-9.]/g, "")
                : "";
              const subExt = KNOWN_SUB_EXTS.includes(urlExt)
                ? urlExt
                : KNOWN_SUB_EXTS.includes(nameExt)
                  ? nameExt
                  : ".srt";
              const safeLang = (lang || "unknown").replace(/[^a-z0-9_-]/gi, "");
              const lIdx = langCounter[safeLang] ?? 0;
              langCounter[safeLang] = lIdx + 1;
              const suffix = lIdx > 0 ? `.${lIdx}` : "";
              const subDestPath = `${videoBase}.${safeLang}${suffix}${subExt}`;
              return downloadSubtitleFile(url, subDestPath)
                .then((ok) =>
                  ok
                    ? {
                        lang: lang || "unknown",
                        path: subDestPath,
                        file_id: file_id || null,
                      }
                    : null,
                )
                // safeFetch rejects (blocked/invalid URL, timeout, network
                // error) rather than resolving false — treat that the same
                // as a failed subtitle fetch instead of failing the whole
                // batch (Promise.all below) for one bad subtitle entry.
                .catch(() => null);
            },
          );
          Promise.all(subPromises).then((results) => {
            const i2 = downloads.findIndex((d) => d.id === id);
            if (i2 !== -1) {
              downloads[i2].subtitlePaths = results.filter(Boolean);
              saveDownloads();
              sendProgress({ id, subtitlePaths: downloads[i2].subtitlePaths });
            }
          });
        }

        sendProgress({
          id,
          name,
          status: downloads[idx].status,
          progress: downloads[idx].progress,
          completedAt: downloads[idx].completedAt,
          filePath: downloads[idx].filePath,
          size: downloads[idx].size,
          completedFragments: downloads[idx].completedFragments,
          totalFragments: downloads[idx].totalFragments,
          lastMessage: downloads[idx].lastMessage,
          logPath: downloads[idx].logPath,
        });
        saveDownloads();
      });

      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── Registry queries / mutations ─────────────────────────────────────────
  const getDownloads = () => downloads;

  function deleteDownload({ id, filePath } = {}) {
    try {
      const dlEntry = downloads.find((d) => d.id === id);
      if (activeProcs.has(id)) {
        try {
          activeProcs.get(id).kill("SIGKILL");
        } catch {}
        activeProcs.delete(id);
      }
      // Only ever unlink inside the downloads dir. Prefer the server-tracked
      // path; honour a client path only when it stays inside bounds.
      const target = dlEntry?.filePath || filePath || null;
      if (target && isPathInside(target, downloadsDir)) {
        try {
          if (fs.existsSync(target)) fs.unlinkSync(target);
        } catch {}
      }
      for (const sp of dlEntry?.subtitlePaths || []) {
        try {
          if (
            sp?.path &&
            isPathInside(sp.path, downloadsDir) &&
            fs.existsSync(sp.path)
          )
            fs.unlinkSync(sp.path);
        } catch {}
      }
      cleanupTempFiles(downloadsDir);
      downloads = downloads.filter((d) => d.id !== id);
      saveDownloads();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function deleteAllDownloads() {
    try {
      let deleted = 0;
      let errors = 0;
      for (const dl of downloads) {
        if (dl.filePath && isPathInside(dl.filePath, downloadsDir)) {
          try {
            if (fs.existsSync(dl.filePath)) {
              fs.unlinkSync(dl.filePath);
              deleted++;
            }
          } catch {
            errors++;
          }
        }
        for (const sp of dl.subtitlePaths || []) {
          try {
            if (
              sp?.path &&
              isPathInside(sp.path, downloadsDir) &&
              fs.existsSync(sp.path)
            )
              fs.unlinkSync(sp.path);
          } catch {}
        }
      }
      downloads = [];
      saveDownloads();
      return { ok: true, deleted, errors };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function getDownloadsSize() {
    let bytes = 0;
    await Promise.all(
      downloads.map(async (dl) => {
        if (!dl.filePath) return;
        try {
          const stat = await fs.promises.stat(dl.filePath);
          if (stat.isFile()) bytes += stat.size;
        } catch {}
      }),
    );
    return { bytes };
  }

  function fileExists(filePath) {
    try {
      if (!filePath || !isPathInside(filePath, downloadsDir)) return false;
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  // Scan for playable video files on the server. `folderPath` is honoured only
  // when it stays inside the downloads dir; otherwise the downloads dir is used.
  function scanDirectory(folderPath) {
    try {
      ensureDownloadsDir();
      let root = downloadsDir;
      if (
        folderPath &&
        isPathInside(folderPath, downloadsDir) &&
        fs.existsSync(folderPath)
      ) {
        root = path.resolve(folderPath);
      }
      if (!fs.existsSync(root)) return [];

      const results = [];
      const scanDir = (dir, depth = 0) => {
        if (depth > 3) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (VIDEO_EXTS.includes(ext)) {
              let size = "";
              try {
                size = humanBytes(fs.statSync(fullPath).size);
              } catch {}
              results.push({
                filePath: fullPath,
                name: path.basename(entry.name, ext),
                size,
                ext,
              });
            }
          }
        }
      };
      scanDir(root);
      return results;
    } catch {
      return [];
    }
  }

  // ── Video duration via ffprobe (ported from src/ipc/player.js) ────────────
  function getVideoDuration(filePath) {
    if (!filePath || !isPathInside(filePath, downloadsDir)) return { ok: false };
    if (!fs.existsSync(filePath)) return { ok: false };

    const probePaths = [
      ffprobeEnv,
      "ffprobe",
      "/usr/bin/ffprobe",
      "/usr/local/bin/ffprobe",
    ].filter(Boolean);
    for (const probe of probePaths) {
      try {
        const result = spawnSync(
          probe,
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            filePath,
          ],
          { encoding: "utf8", timeout: 8000 },
        );
        if (result.status === 0) {
          const secs = parseFloat(result.stdout.trim());
          if (!isNaN(secs) && secs > 0) return { ok: true, duration: secs };
        }
      } catch {}
    }

    const ffmpegPaths = [
      ffmpegEnv,
      "ffmpeg",
      "/usr/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
    ].filter(Boolean);
    for (const ff of ffmpegPaths) {
      try {
        const r = spawnSync(ff, ["-i", filePath], {
          encoding: "utf8",
          timeout: 8000,
        });
        const combined = (r.stdout || "") + (r.stderr || "");
        const m = combined.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (m) {
          const secs =
            parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
          if (secs > 0) return { ok: true, duration: secs };
        }
      } catch {}
    }
    return { ok: false };
  }

  // ── Prune subtitle paths that no longer exist (was in src/ipc/subtitles.js;
  //    routed to /api/downloads/prune-subs by the web shim) ──────────────────
  function pruneSubtitlePaths(downloadId) {
    try {
      const idx = downloads.findIndex((d) => d.id === downloadId);
      if (idx < 0) return { ok: true, subtitlePaths: [] };
      const before = downloads[idx].subtitlePaths || [];
      const after = before.filter((sp) => {
        const p = typeof sp === "string" ? sp : sp?.path;
        return p && fs.existsSync(p);
      });
      if (after.length !== before.length) {
        downloads[idx].subtitlePaths = after;
        saveDownloads();
      }
      return { ok: true, subtitlePaths: after };
    } catch (e) {
      return { ok: false, error: e.message, subtitlePaths: [] };
    }
  }

  // Prime the registry from disk on creation.
  loadDownloads();
  ensureDownloadsDir();

  return {
    downloadsDir,
    checkDownloader,
    runDownload,
    getDownloads,
    deleteDownload,
    deleteAllDownloads,
    getDownloadsSize,
    fileExists,
    scanDirectory,
    getVideoDuration,
    pruneSubtitlePaths,
    loadDownloads,
    saveDownloads,
    killAll,
  };
}

module.exports = {
  createDownloadManager,
  isPathInside,
  downloadSubtitleFile,
  readCapped,
  MAX_SUB_BYTES,
  MAX_SUBTITLES,
};
