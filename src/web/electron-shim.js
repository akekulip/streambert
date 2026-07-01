// Web shim for the Electron `window.electron` contextBridge API.
//
// Installed by main.jsx before <App/> renders. When running in a real Electron
// build, window.electron already exists (from preload.js) and we do nothing.
// In the browser, we implement the same surface against the backend (/api/*),
// direct browser APIs, or safe no-ops. See docs/WEB_PORT.md for the contract.

const json = (r) => r.json();
const api = (path, opts = {}) =>
  fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body ?? {}) }).then(json);
const get = (path) => api(path).then(json);

// ── Event multiplexer over a single WebSocket (/api/events) ──────────────────
// Backs the on*/off* subscription methods. Reconnects with backoff.
const listeners = new Map(); // channel -> Set<fn>
let ws = null;
let wsTimer = null;
function ensureWs() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  try {
    ws = new WebSocket(`${proto}://${location.host}/api/events`);
  } catch {
    return;
  }
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    const set = listeners.get(msg.channel);
    if (set) for (const fn of set) fn(msg.payload);
  };
  ws.onclose = () => {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(ensureWs, 2000);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}
function on(channel, cb) {
  ensureWs();
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  const h = (payload) => cb(payload);
  listeners.get(channel).add(h);
  return h;
}
function off(channel, h) {
  listeners.get(channel)?.delete(h);
}

const noop = () => {};
const asyncNoop = async () => {};

export function installWebShim() {
  if (typeof window === "undefined") return;
  if (window.electron) return; // real Electron — leave preload API intact
  // Browser only: flag must stay falsy under Electron so desktop-only UI and
  // native-webview paths keep working there.
  window.__STREAMBERT_WEB__ = true;

  window.electron = {
    // ── Event subscriptions (multiplexed WS) ────────────────────────────────
    onM3u8Found: (cb) => on("m3u8-found", cb),
    offM3u8Found: (h) => off("m3u8-found", h),
    onSubtitleFound: (cb) => on("subtitle-found", cb),
    offSubtitleFound: (h) => off("subtitle-found", h),
    onDownloadProgress: (cb) => on("download-progress", cb),
    offDownloadProgress: (h) => off("download-progress", h),

    // ── Downloads → /api/downloads (Agent B) ────────────────────────────────
    checkDownloader: (folder) => post("/downloads/check", { folder }),
    runDownload: (args) => post("/downloads", args),
    getDownloads: () => get("/downloads"),
    deleteDownload: (args) => post("/downloads/delete", args),
    scanDirectory: (path) => post("/downloads/scan", { path }),
    fileExists: (path) => post("/downloads/file-exists", { path }),
    getDownloadsSize: () => get("/downloads/size"),
    deleteAllDownloads: () => post("/downloads/delete-all"),
    getVideoDuration: (filePath) =>
      post("/downloads/duration", { filePath }).then((r) => r.duration),
    pruneSubtitlePaths: (downloadId) =>
      post("/downloads/prune-subs", { downloadId }),

    // Completed-file playback: serve via /api/files (Range). Desktop "open in
    // external player at time" has no web analogue → play in-app instead.
    openPath: (filePath) =>
      window.open(`/api/files?path=${encodeURIComponent(filePath)}`, "_blank"),
    openPathAtTime: asyncNoop,
    showInFolder: asyncNoop,

    // ── AllManga anime → /api/allmanga (Agent A) ────────────────────────────
    resolveAllManga: (args) => post("/allmanga/resolve", args),
    extractVidsrc: (args) => post("/extract/vidsrc", args),
    debugAllManga: (args) => post("/allmanga/debug", args),
    setPlayerVideo: (args) => post("/allmanga/set-player-video", args),

    // ── Subtitles → /api/subtitles + /api/wyzie (Agent C) ───────────────────
    searchSubtitles: (args) => post("/subtitles/search", args),
    getSubtitleUrl: (args) => post("/subtitles/url", args),
    downloadSubtitlesForFile: (args) => post("/subtitles/download", args),
    deleteSubtitleFile: (args) => post("/subtitles/delete", args),
    wyzieValidateKey: (key) => post("/wyzie/validate", { key }),
    wyzieOpenRedeem: () =>
      window.open("https://sub.wyzie.ru", "_blank", "noopener"),

    // ── Secure key store → /api/secure (server, behind auth) ────────────────
    secureGet: (key) => get(`/secure/${encodeURIComponent(key)}`).then((r) => r.value ?? null),
    secureSet: (key, value) =>
      api(`/secure/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }).then(json),

    // ── App/meta ────────────────────────────────────────────────────────────
    getAppVersion: () => get("/version").then((r) => r.version),
    getPlatform: () => Promise.resolve("web"),
    getInstallPath: () => Promise.resolve(""),
    getBlockStats: () => Promise.resolve({ ads: 0, trackers: 0, total: 0 }),
    onBlockedUpdate: (cb) => on("blocked-stats-update", cb),
    offBlockedUpdate: (h) => off("blocked-stats-update", h),

    // ── Storage housekeeping (localStorage lives in the renderer) ───────────
    getCacheSize: () => Promise.resolve(0),
    clearAppCache: asyncNoop,
    clearWatchData: asyncNoop,
    queryVideoProgress: asyncNoop,
    resetApp: async () => {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith("streambert_"))
          .forEach((k) => localStorage.removeItem(k));
      } catch {}
    },

    // ── Notifications → web Notification API ────────────────────────────────
    showNotification: async ({ title, body, silent }) => {
      try {
        if (Notification.permission === "granted")
          new Notification(title, { body, silent });
        else if (Notification.permission !== "denied") {
          const p = await Notification.requestPermission();
          if (p === "granted") new Notification(title, { body, silent });
        }
      } catch {}
    },

    // ── External / misc ─────────────────────────────────────────────────────
    openExternal: (url) => window.open(url, "_blank", "noopener"),
    pickFolder: async () => null, // no server-dir picker in browser
    getScheduledBackupSettings: () => Promise.resolve(null),
    setScheduledBackupSettings: asyncNoop,
    performScheduledBackup: asyncNoop,
    onScheduledBackupRequested: () => noop,
    offScheduledBackupRequested: noop,

    // ── Desktop-only: safe no-ops (UI hidden via __STREAMBERT_WEB__) ─────────
    quitApp: asyncNoop,
    playerStopped: noop,
    respondClose: noop,
    onConfirmClose: () => noop,
    offConfirmClose: noop,
    onWebviewEnterFullscreen: () => noop,
    offWebviewEnterFullscreen: noop,
    onWebviewLeaveFullscreen: () => noop,
    offWebviewLeaveFullscreen: noop,
    windowMinimize: asyncNoop,
    windowToggleMaximize: asyncNoop,
    windowClose: asyncNoop,
    windowIsMaximized: () => Promise.resolve(false),
    onWindowMaximize: () => noop,
    offWindowMaximize: noop,
    setZoomFactor: noop,

    // ── Picture-in-Picture (native browser PiP handled in player component) ──
    openPipWindow: asyncNoop,
    closePipWindow: asyncNoop,
    getPipWebContentsId: () => Promise.resolve(null),
    onPipOpened: () => noop,
    offPipOpened: noop,
    onPipClosed: () => noop,
    offPipClosed: noop,

    // ── Auto-updater: disabled on web (server is updated by redeploy) ────────
    detectUpdateFormat: () => Promise.resolve(null),
    downloadAndInstallUpdate: asyncNoop,
    cancelUpdate: asyncNoop,
    onUpdateProgress: () => noop,
    offUpdateProgress: noop,
  };
}
