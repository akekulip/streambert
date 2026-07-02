import { useEffect, useReducer, useCallback } from "react";
import { initialVideoState, reduceVideo } from "./videoState.mjs";

// Subscribes to a <video> element's events and exposes UI state + actions.
// The element is the single source of truth; state is derived from its events.
export function useVideoController(videoRef, { wrapRef, onToggleCaptions } = {}) {
  const [state, dispatch] = useReducer(reduceVideo, initialVideoState);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => dispatch({ type: "play" });
    const onPause = () => dispatch({ type: "pause" });
    const onTime = () => dispatch({ type: "time", current: v.currentTime });
    const onDur = () => dispatch({ type: "duration", duration: v.duration || 0 });
    const onEnded = () => dispatch({ type: "ended" });
    const onVol = () => dispatch({ type: "volume", volume: v.volume, muted: v.muted });
    const onProgress = () => {
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      dispatch({ type: "buffered", bufferedEnd: end });
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("durationchange", onDur);
    v.addEventListener("loadedmetadata", onDur);
    v.addEventListener("ended", onEnded);
    v.addEventListener("volumechange", onVol);
    v.addEventListener("progress", onProgress);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("durationchange", onDur);
      v.removeEventListener("loadedmetadata", onDur);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("volumechange", onVol);
      v.removeEventListener("progress", onProgress);
    };
  }, [videoRef]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play?.().catch(() => {}); else v.pause?.();
  }, [videoRef]);
  const seek = useCallback((t) => {
    const v = videoRef.current; if (v) v.currentTime = Math.max(0, t);
  }, [videoRef]);
  const seekBy = useCallback((d) => {
    const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime + d);
  }, [videoRef]);
  const setVolume = useCallback((val) => {
    const v = videoRef.current; if (!v) return;
    v.volume = Math.min(1, Math.max(0, val)); if (v.volume > 0) v.muted = false;
  }, [videoRef]);
  const volumeBy = useCallback((d) => {
    const v = videoRef.current; if (v) setVolume(v.volume + d);
  }, [videoRef, setVolume]);
  const toggleMute = useCallback(() => {
    const v = videoRef.current; if (v) v.muted = !v.muted;
  }, [videoRef]);
  const setRate = useCallback((r) => {
    const v = videoRef.current; if (v) v.playbackRate = r;
  }, [videoRef]);
  const toggleFullscreen = useCallback(() => {
    const el = wrapRef?.current; if (!el) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  }, [wrapRef]);
  const toggleCaptions = useCallback(() => onToggleCaptions?.(), [onToggleCaptions]);

  return {
    state,
    actions: { togglePlay, seek, seekBy, setVolume, volumeBy, toggleMute, setRate, toggleFullscreen, toggleCaptions },
  };
}
