import { useEffect, useState, useCallback } from "react";
import { STORAGE_KEYS, secureStorage } from "../../utils/storage";

// Searches the existing subtitle providers for a title and exposes a pick list.
// The chosen cue file is resolved to a URL and returned for the player to
// attach as a <track> (proxied for CORS by the caller).
export function useSubtitles({ active, tmdbId, mediaType, season, episode }) {
  const [tracks, setTracks] = useState([]);
  const [current, setCurrent] = useState(null);
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!active || !tmdbId || !window.electron?.searchSubtitles) return;
    let cancelled = false;
    (async () => {
      const [subdlApiKey, wyzieApiKey] = await Promise.all([
        secureStorage.get(STORAGE_KEYS.SUBDL_API_KEY).catch(() => null),
        secureStorage.get(STORAGE_KEYS.WYZIE_API_KEY).catch(() => null),
      ]);
      const res = await window.electron.searchSubtitles({
        tmdbId, mediaType, season, episode, languages: "", subdlApiKey, wyzieApiKey,
      }).catch(() => null);
      if (cancelled || !res?.ok) return;
      setTracks((res.results || []).slice(0, 20).map((r) => ({
        id: r.file_id, label: (r.language || "sub").toUpperCase(), raw: r,
      })));
    })();
    return () => { cancelled = true; };
  }, [active, tmdbId, mediaType, season, episode]);

  const select = useCallback(async (id) => {
    const t = tracks.find((x) => x.id === id);
    if (!t) return;
    const r = await window.electron.getSubtitleUrl(t.raw).catch(() => null);
    if (r?.url) { setUrl(r.url); setCurrent(id); }
  }, [tracks]);

  const off = useCallback(() => { setUrl(null); setCurrent(null); }, []);

  return { tracks, current, url, select, off };
}
