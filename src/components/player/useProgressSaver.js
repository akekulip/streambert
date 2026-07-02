import { useEffect, useRef } from "react";
import { toPct, shouldSave, isWatched } from "./progress.mjs";

// Persists watch position from the native <video> element. Mirrors the
// Electron tracker's semantics (percent to onSaveProgress, seconds to storage,
// auto-mark watched near the end).
export function useProgressSaver({ videoRef, active, progressKey, onSaveProgress, onMarkWatched, watchedThreshold = 20, storage }) {
  const lastAt = useRef(null);
  const marked = useRef(false);

  useEffect(() => { marked.current = false; lastAt.current = null; }, [progressKey]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !active || !progressKey) return;

    const persist = () => {
      const { currentTime: ct, duration: dur } = v;
      if (!dur || dur <= 0 || v.paused) return;
      onSaveProgress?.(progressKey, toPct(ct, dur));
      storage?.set?.("dlTime_" + progressKey, Math.floor(ct));
      if (!marked.current && isWatched(ct, dur, watchedThreshold)) {
        marked.current = true;
        onMarkWatched?.(progressKey);
      }
    };
    const onTime = () => {
      const now = Date.now();
      if (!shouldSave(lastAt.current, now)) return;
      lastAt.current = now;
      persist();
    };
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("timeupdate", onTime);
    };
  }, [videoRef, active, progressKey, onSaveProgress, onMarkWatched, watchedThreshold, storage]);
}
