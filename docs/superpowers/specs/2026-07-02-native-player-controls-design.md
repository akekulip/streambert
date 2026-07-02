# Custom Native Player Controls — Design

Date: 2026-07-02
Status: approved (brainstorming session with Philip)

## Problem

The plain VidSrc and Videasy sources are cross-origin iframe **embeds** — we
cannot restyle their controls, fix their broken fullscreen, or strip their
ads (same-origin policy locks us out of the frame). The one player we own is
the native HTML5 `<video>` (`WebMediaPlayer`), used today only for extracted
sources (AllManga and VidSrc Direct). Philip wants a proper, app-styled
player experience there: a custom control bar, working fullscreen, resume,
subtitles, and keyboard shortcuts.

## Scope & boundary

- **Web build only** (`window.__STREAMBERT_WEB__`). The desktop Electron
  `<webview>` player is untouched.
- The custom bar lives on `WebMediaPlayer`, which serves **all native-player
  sources** — VidSrc Direct (the primary target) and, as a bonus, AllManga.
  The iframe **embeds** (Videasy, plain VidSrc) keep their own in-frame
  controls; when they're used as the extraction fallback, we do not (and
  cannot) change them.

## 1. Component architecture

- `WebMediaPlayer` (`src/components/WebPlayer.jsx`) drops the `controls`
  attribute and renders a sibling `<VideoControls>` overlay.
- New hook `useVideoController(videoRef)` subscribes to element events
  (`timeupdate`, `play`, `pause`, `volumechange`, `progress`, `waiting`,
  `ended`, `loadedmetadata`) and exposes read state
  (`{playing, current, duration, buffered, volume, muted, ready}`) plus
  actions (`togglePlay`, `seek`, `seekBy`, `setVolume`, `toggleMute`,
  `toggleFullscreen`). Controls read real element state — no polling, no
  `executeJavaScript`.
- `VideoControls` and the hook are their own files (keep `WebPlayer.jsx`
  focused, per the small-file convention).

## 2. Control bar layout

```
┌──────────────────────────────────────────────────────────────┐
│                      (video fills wrap)                      │
│  ●━━━━━━━━━━━━━━━━━━○·············································  │ scrub + buffered; hover = time preview
│  ▶  ⏪10 ⏩10   12:34 / 58:20        CC ▾   ⚙   ⛶  ⧉        │
│  play  seek     time            subs  speed  FS  PiP        │
└──────────────────────────────────────────────────────────────┘
```

- Accent-colored progress fill; buffered ranges shown as a lighter track.
- Auto-hides after ~3s idle; reappears on mouse-move / tap / focus.
- Volume is a hover-slider on the play cluster.
- Rendered **inside `player-wrap`** so it remains visible in fullscreen.
- `⚙` speed menu (0.5×–2×); `⧉` PiP via `video.requestPictureInPicture()`.

## 3. Resume / progress tracking

- `timeupdate` → throttled (~5s) save through the existing per-user state
  API (`PUT /api/state/progress/:key`); `navigator.sendBeacon` to
  `/api/state/progress/beacon` on `pagehide`/`beforeunload`.
- On `loadedmetadata`, seek to the saved position (the `startTime` prop
  already flows into `WebMediaPlayer`).
- Mark watched at the existing threshold (default 20% remaining).
- Flip VidSrc Direct's `supportsProgress` to `true` in `PLAYER_SOURCES` —
  the new tracking makes it real, so the "⚠ no tracking" badge disappears.

## 4. Subtitles

- On play, call the existing `searchSubtitles({tmdb, type, lang})`
  (`/api/subtitles/search`) and populate the **CC ▾** menu.
- On selection, resolve via `getSubtitleUrl`, fetch the VTT through
  `/api/proxy` (CORS/Referer), attach as a `<track>` (browser renders cues).
- Default **Off**; last choice remembered per-user (state settings).

## 5. Keyboard shortcuts

`Space`/`k` play-pause · `←`/`→` seek ±10s · `↑`/`↓` volume ±10% ·
`f` fullscreen · `m` mute · `c` captions. Active only when the player is
mounted/focused; ignored while an input/textarea is focused so they never
fire during typing.

## 6. Default source + fallback

- `NON_ANIME_DEFAULT_SOURCE` becomes `vidsrc-direct` **in the web build
  only**. On desktop, `vidsrc-direct` has no resolver, so the constant must
  resolve web-conditionally (e.g. a `getDefaultNonAnimeSource()` that returns
  `vidsrc-direct` under `__STREAMBERT_WEB__`, else `vidsrc`). This supersedes
  the interim Videasy default committed earlier this session.
- The extraction-failure fallback chain is unchanged: a failed VidSrc Direct
  extraction still falls through to the first non-async source (Videasy),
  which plays in its own embed with its own controls.

## 7. Testing

- Unit: `useVideoController` state transitions, throttled save cadence,
  seek-to-resume on metadata, watched-threshold mark.
- Unit: subtitle menu populate + select → `<track>` attach; keyboard
  handler mapping and the input-focus guard.
- Manual web pass: play a movie on VidSrc Direct → bar is app-styled,
  fullscreen works, reload resumes position, subtitles attach, shortcuts
  respond; confirm Videasy fallback still shows its own controls.

## Out of scope

- Desktop Electron player changes.
- Restyling or fixing embed (Videasy / plain VidSrc) controls — impossible
  cross-origin.
- Quality/variant selection UI beyond playback speed (hls.js auto-selects;
  revisit if needed).
