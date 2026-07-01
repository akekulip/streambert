import { useEffect, useRef } from "react";

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

// <iframe> for movie/TV embed sources. No sandbox: several providers detect the
// sandbox *attribute* itself and refuse to play ("Iframe Sandbox Detected"),
// even when scripts/forms are allowed. Trade-off: without it an ad script in the
// embed can `top.location = …` and hijack/wipe the app — but that only fires when
// an ad domain actually loads, which the deployment's AdGuard DNS blocks. So we
// keep the sandbox off for compatibility and rely on the ad-blocker.
export function WebEmbedPlayer({ src, hidden, onReady }) {
  return (
    <iframe
      title="Player"
      src={src}
      onLoad={onReady}
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      allowFullScreen
      style={{ ...PLAYER_STYLE, visibility: hidden ? "hidden" : "visible" }}
    />
  );
}

// HTML5 <video> for direct media. Uses hls.js for .m3u8 (with native HLS
// fallback on Safari/iOS) and plain <video> for .mp4. Remote URLs are proxied.
export function WebMediaPlayer({ src, referer, startTime = 0, hidden, onReady }) {
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

  return (
    <video
      ref={videoRef}
      controls
      autoPlay
      playsInline
      onLoadedMetadata={(e) => {
        if (!seekedRef.current && startTime > 0) {
          seekedRef.current = true;
          try {
            e.currentTarget.currentTime = startTime;
          } catch {}
        }
        onReady?.();
      }}
      onCanPlay={onReady}
      style={{ ...PLAYER_STYLE, visibility: hidden ? "hidden" : "visible" }}
    />
  );
}
