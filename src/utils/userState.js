// Server-backed per-user state sync (web build only — Phase 2).
// Mirrors every write to localStorage (instant paint + offline fallback) and
// syncs it to /api/state. Desktop builds never call init(), so all exports
// no-op there. Convergence guarantee: any failed write sets a dirty flag and
// the full local state is re-pushed through the idempotent POST /import.
import { storage, registerStorageSetListener } from "./storage";

const DIRTY_KEY = "dirtyState"; // stored as streambert_dirtyState
const PROGRESS_INTERVAL_MS = 10 * 1000;
const REFETCH_GUARD_MS = 5 * 1000;
const REFETCH_DEBOUNCE_MS = 1000;

// localStorage keys (unprefixed) that sync as user-level settings. Everything
// else — device prefs (fontSize, compactMode, reduceAnimations, dl*) and
// caches — stays local. See spec "Settings split".
const SYNCED_SETTINGS = new Set([
  "playerSource", "allmangaDubMode", "startPage", "ageLimit", "ratingCountry",
  "watchedThreshold", "autoplayNextEnabled", "autoplayNextDuration",
  "autoplayNextLayout", "homeRowOrder", "homeRowVisible", "homeViewMode",
  "subtitleDownload", "subtitleLang", "introSkipMode", "librarySort",
  "historyEnabled", "accentColor", "invidiousBase", "browseFilters",
]);

let _enabled = false;
let _initedFor = null;
let _applying = false;
let _apply = null;
let _lastWriteAt = 0;
let _refetchTimer = null;
let _reconcilePromise = null;
let _listenersInstalled = false;
let _epoch = 0; // bumped on user switch; invalidates in-flight async work

const _pendingProgress = new Map(); // key -> pct
let _progressTimer = null;
let _lastProgressSend = 0;

const _pendingSettings = {};
let _settingsTimer = null;

function markDirty() {
  storage.set(DIRTY_KEY, 1);
}

async function api(method, path, body) {
  const res = await fetch(`/api/state${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res;
}

// Fire-and-forget write; failures set the dirty flag for later reconcile.
function send(method, path, body) {
  if (!_enabled) return;
  _lastWriteAt = Date.now();
  api(method, path, body).catch(() => markDirty());
}

function collectLocalState() {
  const settings = {};
  for (const k of SYNCED_SETTINGS) {
    const v = storage.get(k);
    if (v !== null) settings[k] = v;
  }
  return {
    progress: storage.get("progress") || {},
    watched: storage.get("watched") || {},
    history: storage.get("history") || [],
    saved: storage.get("saved") || {},
    savedOrder: storage.get("savedOrder"),
    settings,
  };
}

function hasLocalContent(s) {
  return (
    Object.keys(s.progress).length > 0 || Object.keys(s.watched).length > 0 ||
    s.history.length > 0 || Object.keys(s.saved).length > 0
  );
}

function serverIsEmpty(boot) {
  return (
    Object.keys(boot.progress).length === 0 && Object.keys(boot.watched).length === 0 &&
    boot.history.length === 0 && Object.keys(boot.library).length === 0
  );
}

function clearLocalState() {
  for (const k of ["progress", "watched", "history", "saved", "savedOrder", DIRTY_KEY]) {
    storage.remove(k);
  }
  for (const k of SYNCED_SETTINGS) storage.remove(k);
}

// Write server truth into the localStorage mirror + React state, suppressing
// the storage.set listener so settings don't echo back to the server.
function applyResult(data) {
  _applying = true;
  try {
    storage.set("progress", data.progress || {});
    storage.set("watched", data.watched || {});
    storage.set("history", data.history || []);
    storage.set("saved", data.library || {});
    if (data.libraryOrder) storage.set("savedOrder", data.libraryOrder);
    else storage.remove("savedOrder");
    for (const [k, v] of Object.entries(data.settings || {})) storage.set(k, v);
  } finally {
    _applying = false;
  }
  if (_apply) _apply(data);
}

// Bootstrap / migrate / reconcile. Safe to call repeatedly (focus, online,
// state-changed). Leaves _enabled false when the server is unreachable so
// writes stay local-only until the next attempt.
async function doReconcile() {
  // Epoch guard: a user switch mid-flight (init() bumps _epoch) must abandon
  // this run before it applies the previous user's data or re-enables writes.
  const epoch = _epoch;
  try {
    const dirty = storage.get(DIRTY_KEY);
    if (_enabled && dirty) {
      const merged = await (await api("POST", "/import", collectLocalState())).json();
      if (epoch !== _epoch) return;
      storage.remove(DIRTY_KEY);
      applyResult(merged);
      return;
    }
    let boot = await (await api("GET", "/bootstrap")).json();
    if (epoch !== _epoch) return;
    const migratedFlag = `streambert_migrated_${_initedFor}`;
    const local = collectLocalState();
    if (serverIsEmpty(boot) && hasLocalContent(local) && !localStorage.getItem(migratedFlag)) {
      boot = await (await api("POST", "/import", local)).json();
      if (epoch !== _epoch) return;
      localStorage.setItem(migratedFlag, "1");
    } else if (storage.get(DIRTY_KEY)) {
      boot = await (await api("POST", "/import", local)).json();
      if (epoch !== _epoch) return;
    }
    storage.remove(DIRTY_KEY);
    _enabled = true;
    applyResult(boot);
  } catch {
    /* offline / unauthenticated: stay on the localStorage cache */
  }
}

// Single-flight: focus, online, and state-changed can all fire at once —
// overlapping reconciles whose responses resolve out of order would let an
// older snapshot overwrite a newer one, so concurrent callers share one run.
function reconcile() {
  if (_reconcilePromise) return _reconcilePromise;
  const p = doReconcile().finally(() => {
    // Only clear our own reference — a stale run finishing after a user
    // switch must not null out the newer run's promise.
    if (_reconcilePromise === p) _reconcilePromise = null;
  });
  _reconcilePromise = p;
  return p;
}

function onStorageSet(key, value) {
  if (!_enabled || _applying || !SYNCED_SETTINGS.has(key)) return;
  _pendingSettings[key] = value;
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(() => {
    const batch = { ..._pendingSettings };
    for (const k of Object.keys(_pendingSettings)) delete _pendingSettings[k];
    send("PUT", "/settings", batch);
  }, 500);
}

function onRemoteChange() {
  // Skip refetches triggered by our own just-sent writes.
  if (Date.now() - _lastWriteAt < REFETCH_GUARD_MS) return;
  clearTimeout(_refetchTimer);
  _refetchTimer = setTimeout(() => reconcile(), REFETCH_DEBOUNCE_MS);
}

function sendPendingProgress() {
  _lastProgressSend = Date.now();
  for (const [key, pct] of _pendingProgress) {
    send("PUT", `/progress/${encodeURIComponent(key)}`, { pct });
  }
  _pendingProgress.clear();
}

export function flushProgress() {
  if (_progressTimer) {
    clearTimeout(_progressTimer);
    _progressTimer = null;
  }
  if (!_enabled || _pendingProgress.size === 0) return;
  for (const [key, pct] of _pendingProgress) {
    try {
      navigator.sendBeacon("/api/state/progress/beacon", JSON.stringify({ key, pct }));
    } catch {}
  }
  _pendingProgress.clear();
}

export async function init(me, applyServerState) {
  _apply = applyServerState;
  if (_initedFor === me.id) {
    reconcile();
    return;
  }
  // First init or a different user: quiesce ALL of the previous user's async
  // work — invalidate in-flight reconciles (epoch), drop queued writes and
  // timers — so nothing of theirs can land in the new user's state or account.
  _epoch += 1;
  _reconcilePromise = null; // do not attach to the previous user's in-flight run
  _pendingProgress.clear();
  if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
  for (const k of Object.keys(_pendingSettings)) delete _pendingSettings[k];
  if (_settingsTimer) { clearTimeout(_settingsTimer); _settingsTimer = null; }
  if (_refetchTimer) { clearTimeout(_refetchTimer); _refetchTimer = null; }
  // Block stale-enabled writes from firing between the clear below and the
  // fresh hydrate.
  _enabled = false;
  // Shared-browser safety: a different user logged in — drop the previous
  // user's cached state BEFORE hydrating so it is never shown or imported.
  const last = localStorage.getItem("streambert_lastUserId");
  if (last && last !== String(me.id)) clearLocalState();
  localStorage.setItem("streambert_lastUserId", String(me.id));
  _initedFor = me.id;

  // Register listeners once per module lifetime — they read the current user
  // from module state, so re-running init() must not stack duplicate handlers.
  if (!_listenersInstalled) {
    registerStorageSetListener(onStorageSet);
    window.addEventListener("focus", () => reconcile());
    window.addEventListener("online", () => reconcile());
    window.addEventListener("pagehide", flushProgress);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushProgress();
    });
    if (window.electron?.onStateChanged) window.electron.onStateChanged(onRemoteChange);
    _listenersInstalled = true;
  }

  await reconcile();
}

export function saveProgress(nextObj, key, pct) {
  storage.set("progress", nextObj);
  if (!_enabled) return;
  _pendingProgress.set(key, pct);
  const since = Date.now() - _lastProgressSend;
  if (since >= PROGRESS_INTERVAL_MS) {
    sendPendingProgress();
  } else if (!_progressTimer) {
    _progressTimer = setTimeout(() => {
      _progressTimer = null;
      sendPendingProgress();
    }, PROGRESS_INTERVAL_MS - since);
  }
}

export function setWatchedState(nextObj, key, on) {
  storage.set("watched", nextObj);
  send(on ? "PUT" : "DELETE", `/watched/${encodeURIComponent(key)}`);
}

export function addHistoryEntry(nextArr, entry) {
  storage.set("history", nextArr);
  send("POST", "/history", entry);
}

export function saveLibraryItem(nextObj, key, item) {
  storage.set("saved", nextObj);
  send("PUT", `/library/${encodeURIComponent(key)}`, item);
}

export function removeLibraryItem(nextObj, key) {
  storage.set("saved", nextObj);
  send("DELETE", `/library/${encodeURIComponent(key)}`);
}

export function saveLibraryOrder(nextArr) {
  storage.set("savedOrder", nextArr);
  send("PUT", "/library/order", { keys: nextArr });
}
