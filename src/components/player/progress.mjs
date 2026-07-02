// Progress math, kept DOM-free so it can be unit-tested. Semantics mirror the
// existing Electron-webview tracker in MoviePage.jsx.
export function toPct(current, duration) {
  if (!duration || duration <= 0) return 0;
  return Math.min(Math.floor((current / duration) * 100), 100);
}

export function shouldSave(lastAt, now, intervalMs = 5000) {
  return lastAt == null || now - lastAt >= intervalMs;
}

export function isWatched(current, duration, thresholdSecs = 20) {
  if (!duration || duration <= 0) return false;
  const remaining = duration - current;
  return remaining >= 0 && remaining <= thresholdSecs;
}
