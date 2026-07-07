import { useEffect, useRef, useState, useCallback } from "react";

import { useVideoController } from "./player/useVideoController";
import { useProgressSaver } from "./player/useProgressSaver";
import { useSubtitles } from "./player/useSubtitles";
import { useKeyboardShortcuts } from "./player/useKeyboardShortcuts";
import VideoControls from "./player/VideoControls";

// Browser player elements used only when window.__STREAMBERT_WEB__ is set.
// The desktop build keeps using the Electron <webview>; these are the web
// replacements: a sandboxed <iframe> for embed sources (videasy / vidsrc /
// 2embed) and an HTML5 <video> (+ hls.js) for direct media (AllManga).

// Route remote CDN media through the backend proxy so the CDN's Referer/Origin
// gate, CORS, and Range requests are handled server-side. Same-origin, blob and
// data URLs (e.g. completed downloads served from /api/files) are used directly.
function toMediaSrc(url, referer) {
  if (!url) return url;
  if (/^(blob:|data:)/i.test(url)) return url;
  try {
    const u = new URL(url, window.location.href);
    if (u.origin === window.location.origin) return url;
  } catch {
    return url;
  }
  const ref = referer ? `&referer=${encodeURIComponent(referer)}` : "";
  return `/api/proxy?url=${encodeURIComponent(url)}${ref}`;
}

const PLAYER_STYLE = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  border: "none",
  outline: "none",
  background: "black",
};

// <iframe> for movie/TV embed sources. Sandboxed to block top-nav hijack: no
// allow-top-navigation(-by-user-activation), so a malicious ad inside the
// embed can't `top.location =` the tab to a phishing page. allow-same-origin
// is scoped to the iframe's own (cross-origin) origin, not ours, so it doesn't
// grant the embed access to this app. allow-popups is required in practice:
// providers probe window.open() and refuse to play ("Iframe Sandbox Detected")
// when it's blocked. Popups inherit the sandbox (no
// allow-popups-to-escape-sandbox), which keeps spawned ad windows neutered.
export function WebEmbedPlayer({ src, hidden, onReady }) {
  return (
    <iframe
      title="Player"
      src={src}
      onLoad={onReady}
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      allowFullScreen
      sandbox="allow-scripts allow-same-origin allow-presentation allow-forms allow-popups"
      style={{ ...PLAYER_STYLE, visibility: hidden ? "hidden" : "visible" }}
    />
  );
}

// HTML5 <video> for direct media. Uses hls.js for .m3u8 (with native HLS
// fallback on Safari/iOS) and plain <video> for .mp4. Remote URLs are proxied.
export function WebMediaPlayer({ src, referer, startTime = 0, hidden, onReady, wrapRef,
  tmdbId, mediaType, season, episode,
  progressKey, onSaveProgress, onMarkWatched, watchedThreshold, storage }) {
  const videoRef = useRef(null);
  const seekedRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    seekedRef.current = false;

    const mediaSrc = toMediaSrc(src, referer);
    const isHls = /\.m3u8(\?|#|$)/i.test(src);
    const nativeHls = video.canPlayType("application/vnd.apple.mpegurl");
    let hls = null;
    let cancelled = false;

    if (isHls && !nativeHls) {
      import("hls.js")
        .then(({ default: Hls }) => {
          if (cancelled) return;
          if (!Hls.isSupported()) {
            video.src = mediaSrc;
            return;
          }
          // Wrap every playlist/segment fetch through the same proxy so each
          // request carries the spoofed Referer/Origin and passes CORS.
          class ProxyLoader extends Hls.DefaultConfig.loader {
            load(context, config, callbacks) {
              context.url = toMediaSrc(context.url, referer);
              super.load(context, config, callbacks);
            }
          }
          hls = new Hls({ loader: ProxyLoader });
          hls.loadSource(mediaSrc);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            onReady?.();
            video.play?.().catch(() => {});
          });
        })
        .catch(() => {
          if (!cancelled) video.src = mediaSrc;
        });
    } else {
      video.src = mediaSrc;
    }

    return () => {
      cancelled = true;
      if (hls) {
        try {
          hls.destroy();
        } catch {}
      }
    };
  }, [src, referer]);

  const subsCtl = useSubtitles({ active: !hidden && !!src, tmdbId, mediaType, season, episode });
  const subs = subsCtl.tracks.length ? subsCtl : null;

  const { state, actions } = useVideoController(videoRef, {
    wrapRef,
    onToggleCaptions: () => subs && (subs.current ? subs.off() : subs.tracks[0] && subs.select(subs.tracks[0].id)),
  });
  useKeyboardShortcuts({ active: !hidden && !!src, actions });
  useProgressSaver({ videoRef, active: !hidden && !!src, progressKey, onSaveProgress, onMarkWatched, watchedThreshold, storage });
  // Force the attached <track> to show — browsers don't reliably honor the
  // `default` attribute on a dynamically-added track. Runs after the track
  // element mounts for the current subtitle URL.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      v.textTracks[i].mode = subsCtl.url ? "showing" : "disabled";
    }
  }, [subsCtl.url]);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef(null);
  const poke = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);
  // Kick off the idle countdown on mount so controls hide after ~3s of no
  // activity, and clear the timer on unmount.
  useEffect(() => { poke(); return () => clearTimeout(hideTimer.current); }, [poke]);

  return (
    <div onMouseMove={poke} onTouchStart={poke} style={{ position: "absolute", inset: 0 }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        onLoadedMetadata={(e) => {
          if (!seekedRef.current && startTime > 0) {
            seekedRef.current = true;
            try { e.currentTarget.currentTime = startTime; } catch {}
          }
          onReady?.();
        }}
        onCanPlay={onReady}
        onClick={actions.togglePlay}
        style={{ ...PLAYER_STYLE, visibility: hidden ? "hidden" : "visible" }}
      >
        {subsCtl.url && (
          <track key={subsCtl.url} kind="subtitles" default src={toMediaSrc(subsCtl.url, referer)} srcLang="sub" label="Subtitles" />
        )}
      </video>
      {!hidden && <VideoControls state={state} actions={actions} subs={subs} visible={controlsVisible} />}
    </div>
  );
}
