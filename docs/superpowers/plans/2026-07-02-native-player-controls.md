# Custom Native Player Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web build's native `<video>` player (VidSrc Direct / AllManga) an app-styled control bar with working fullscreen, resume, subtitles, and keyboard shortcuts.

**Architecture:** DOM/React-free logic lives in pure `.mjs` modules under `src/components/player/` (tested with `node --test`, mirroring the `eval/*.mjs` precedent). Thin React hooks/components consume that logic and are verified with `vite build` + a manual browser pass, since the repo has no React test runner. `WebMediaPlayer` (`src/components/WebPlayer.jsx`) drops native `controls` and renders the custom `<VideoControls>` overlay. Iframe embeds (Videasy, plain VidSrc) are untouched.

**Tech Stack:** React (Vite ESM, JSX), plain HTML5 `<video>` + hls.js, `node:test` for pure logic, fastify server APIs already in place (`/api/state/progress`, `/api/subtitles`, `/api/proxy`).

## Global Constraints

- **Node toolchain:** default `node` on PATH is v10 and cannot run tests or builds. Every `node`/`npm`/`vite` command MUST use v20: prefix each shell block with `export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"`.
- **Web build only:** all new behavior is gated by `window.__STREAMBERT_WEB__`. The desktop Electron `<webview>` path in `MoviePage.jsx` / `TVPage.jsx` MUST remain byte-for-byte unchanged.
- **Pure modules are `.mjs` with ESM `export`** so both `node --test` and Vite can import them. React files stay `.js`/`.jsx`.
- **No new npm dependencies.** hls.js is already a dependency; everything else is stdlib/DOM/React.
- **Match existing progress semantics exactly:** `pct = floor(current/duration*100)`, capped at 100; persist seconds to `storage` key `dlTime_<progressKey>`; auto-mark watched when `remaining = duration - current`, `0 <= remaining <= watchedThreshold` (threshold is in **seconds**, default 20).
- **Commit style:** Conventional Commits; end body with the repo's `Co-Authored-By: Claude Fable 5` + `Claude-Session` trailers.
- **Style:** inline styles with CSS vars (`var(--accent)`, `var(--text2)`) as in `AdminDashboard.jsx` / `WebPlayer.jsx`; no global CSS edits.

---

## File Structure

**Create (pure, tested):**
- `src/components/player/format.mjs` — `formatTime`
- `src/components/player/progress.mjs` — `toPct`, `shouldSave`, `isWatched`
- `src/components/player/videoState.mjs` — `initialVideoState`, `reduceVideo`
- `src/components/player/keymap.mjs` — `keyToAction`
- `src/utils/defaultSource.mjs` — `defaultNonAnimeSource`
- plus a `.test.mjs` beside each of the five modules

**Create (React, build + manual verified):**
- `src/components/player/useVideoController.js`
- `src/components/player/useProgressSaver.js`
- `src/components/player/useSubtitles.js`
- `src/components/player/useKeyboardShortcuts.js`
- `src/components/player/VideoControls.jsx`

**Modify:**
- `src/utils/api.js` — add `getDefaultNonAnimeSource()`, flip `vidsrc-direct` `supportsProgress: true`
- `src/components/WebPlayer.jsx` — `WebMediaPlayer` renders controls + accepts new props
- `src/pages/MoviePage.jsx` — pass player props; use `getDefaultNonAnimeSource()`
- `src/pages/TVPage.jsx` — same

---

## Task 1: Pure time + progress math

**Files:**
- Create: `src/components/player/format.mjs`
- Create: `src/components/player/progress.mjs`
- Test: `src/components/player/format.test.mjs`, `src/components/player/progress.test.mjs`

**Interfaces:**
- Produces: `formatTime(secs:number)->string`; `toPct(current:number,duration:number)->number` (0–100 int); `shouldSave(lastAt:number|null, now:number, intervalMs?=5000)->boolean`; `isWatched(current:number, duration:number, thresholdSecs?=20)->boolean`

- [ ] **Step 1: Write the failing tests**

`src/components/player/format.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert";
import { formatTime } from "./format.mjs";

test("formats under an hour as m:ss", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(9), "0:09");
  assert.equal(formatTime(754), "12:34");
});
test("formats over an hour as h:mm:ss", () => {
  assert.equal(formatTime(3661), "1:01:01");
});
test("clamps NaN/negative to 0:00", () => {
  assert.equal(formatTime(NaN), "0:00");
  assert.equal(formatTime(-5), "0:00");
});
```

`src/components/player/progress.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert";
import { toPct, shouldSave, isWatched } from "./progress.mjs";

test("toPct floors and caps at 100", () => {
  assert.equal(toPct(30, 120), 25);
  assert.equal(toPct(121, 120), 100);
  assert.equal(toPct(10, 0), 0);
});
test("shouldSave respects interval and first-save", () => {
  assert.equal(shouldSave(null, 1000), true);
  assert.equal(shouldSave(1000, 5999), false);
  assert.equal(shouldSave(1000, 6000), true);
});
test("isWatched when remaining within threshold seconds", () => {
  assert.equal(isWatched(100, 120, 20), true);   // 20s left
  assert.equal(isWatched(99, 120, 20), false);    // 21s left
  assert.equal(isWatched(120, 120, 20), true);    // 0s left
  assert.equal(isWatched(10, 0, 20), false);      // no duration
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/components/player/format.test.mjs src/components/player/progress.test.mjs
```
Expected: FAIL — cannot find module `./format.mjs` / `./progress.mjs`.

- [ ] **Step 3: Write the implementations**

`src/components/player/format.mjs`:
```js
// Seconds -> "m:ss" (or "h:mm:ss" past an hour). Clamps junk to 0.
export function formatTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
```

`src/components/player/progress.mjs`:
```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/components/player/format.test.mjs src/components/player/progress.test.mjs
```
Expected: PASS — all assertions, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/components/player/format.mjs src/components/player/format.test.mjs src/components/player/progress.mjs src/components/player/progress.test.mjs
git commit -m "feat(player): pure time + progress math with tests"
```

---

## Task 2: Pure video-state reducer

**Files:**
- Create: `src/components/player/videoState.mjs`
- Test: `src/components/player/videoState.test.mjs`

**Interfaces:**
- Produces: `initialVideoState` (object); `reduceVideo(state, event)->state` where event `type` ∈ `play|pause|time|duration|buffered|volume|ended`.

- [ ] **Step 1: Write the failing test**

`src/components/player/videoState.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert";
import { initialVideoState, reduceVideo } from "./videoState.mjs";

test("play/pause toggle playing", () => {
  const s = reduceVideo(initialVideoState, { type: "play" });
  assert.equal(s.playing, true);
  assert.equal(reduceVideo(s, { type: "pause" }).playing, false);
});
test("duration marks ready", () => {
  const s = reduceVideo(initialVideoState, { type: "duration", duration: 120 });
  assert.equal(s.duration, 120);
  assert.equal(s.ready, true);
});
test("time and buffered update fields", () => {
  let s = reduceVideo(initialVideoState, { type: "time", current: 12 });
  s = reduceVideo(s, { type: "buffered", bufferedEnd: 40 });
  assert.equal(s.current, 12);
  assert.equal(s.bufferedEnd, 40);
});
test("volume carries muted flag; ended stops playback", () => {
  let s = reduceVideo(initialVideoState, { type: "volume", volume: 0.3, muted: true });
  assert.deepEqual([s.volume, s.muted], [0.3, true]);
  s = reduceVideo({ ...s, playing: true }, { type: "ended" });
  assert.deepEqual([s.playing, s.ended], [false, true]);
});
test("unknown event returns same reference", () => {
  assert.equal(reduceVideo(initialVideoState, { type: "nope" }), initialVideoState);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/components/player/videoState.test.mjs
```
Expected: FAIL — cannot find module `./videoState.mjs`.

- [ ] **Step 3: Write the implementation**

`src/components/player/videoState.mjs`:
```js
// Pure reducer for the native player's UI state. The hook (useVideoController)
// subscribes to the <video> element's events and dispatches these.
export const initialVideoState = {
  playing: false,
  current: 0,
  duration: 0,
  bufferedEnd: 0,
  volume: 1,
  muted: false,
  ready: false,
  ended: false,
};

export function reduceVideo(state, event) {
  switch (event.type) {
    case "play": return { ...state, playing: true, ended: false };
    case "pause": return { ...state, playing: false };
    case "time": return { ...state, current: event.current };
    case "duration": return { ...state, duration: event.duration, ready: true };
    case "buffered": return { ...state, bufferedEnd: event.bufferedEnd };
    case "volume": return { ...state, volume: event.volume, muted: event.muted };
    case "ended": return { ...state, playing: false, ended: true };
    default: return state;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/components/player/videoState.test.mjs
```
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/components/player/videoState.mjs src/components/player/videoState.test.mjs
git commit -m "feat(player): pure video-state reducer with tests"
```

---

## Task 3: Pure keyboard map

**Files:**
- Create: `src/components/player/keymap.mjs`
- Test: `src/components/player/keymap.test.mjs`

**Interfaces:**
- Produces: `keyToAction(key:string, ctx:{typingInInput?:boolean})->{type:string, delta?:number}|null`. Action types: `togglePlay|seekBy|volumeBy|toggleFullscreen|toggleMute|toggleCaptions`.

- [ ] **Step 1: Write the failing test**

`src/components/player/keymap.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert";
import { keyToAction } from "./keymap.mjs";

test("space and k toggle play", () => {
  assert.deepEqual(keyToAction(" ", {}), { type: "togglePlay" });
  assert.deepEqual(keyToAction("k", {}), { type: "togglePlay" });
});
test("arrows seek and change volume", () => {
  assert.deepEqual(keyToAction("ArrowLeft", {}), { type: "seekBy", delta: -10 });
  assert.deepEqual(keyToAction("ArrowRight", {}), { type: "seekBy", delta: 10 });
  assert.deepEqual(keyToAction("ArrowUp", {}), { type: "volumeBy", delta: 0.1 });
  assert.deepEqual(keyToAction("ArrowDown", {}), { type: "volumeBy", delta: -0.1 });
});
test("f/m/c map to fullscreen/mute/captions", () => {
  assert.deepEqual(keyToAction("f", {}), { type: "toggleFullscreen" });
  assert.deepEqual(keyToAction("m", {}), { type: "toggleMute" });
  assert.deepEqual(keyToAction("c", {}), { type: "toggleCaptions" });
});
test("no action while typing, or for unmapped keys", () => {
  assert.equal(keyToAction(" ", { typingInInput: true }), null);
  assert.equal(keyToAction("q", {}), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/components/player/keymap.test.mjs
```
Expected: FAIL — cannot find module `./keymap.mjs`.

- [ ] **Step 3: Write the implementation**

`src/components/player/keymap.mjs`:
```js
// Map a keyboard key to a player action, or null. ctx.typingInInput guards
// against hijacking keys while the user types in a field.
export function keyToAction(key, ctx) {
  if (ctx && ctx.typingInInput) return null;
  switch (key) {
    case " ":
    case "k": return { type: "togglePlay" };
    case "ArrowLeft": return { type: "seekBy", delta: -10 };
    case "ArrowRight": return { type: "seekBy", delta: 10 };
    case "ArrowUp": return { type: "volumeBy", delta: 0.1 };
    case "ArrowDown": return { type: "volumeBy", delta: -0.1 };
    case "f": return { type: "toggleFullscreen" };
    case "m": return { type: "toggleMute" };
    case "c": return { type: "toggleCaptions" };
    default: return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/components/player/keymap.test.mjs
```
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/components/player/keymap.mjs src/components/player/keymap.test.mjs
git commit -m "feat(player): pure keyboard-map with tests"
```

---

## Task 4: Web-conditional default source + supportsProgress flip

**Files:**
- Create: `src/utils/defaultSource.mjs`
- Test: `src/utils/defaultSource.test.mjs`
- Modify: `src/utils/api.js` (line 472 area `NON_ANIME_DEFAULT_SOURCE`; line ~179 `vidsrc-direct` `supportsProgress`)

**Interfaces:**
- Produces: `defaultNonAnimeSource(isWeb:boolean)->"vidsrc-direct"|"vidsrc"`; `getDefaultNonAnimeSource()->string` (reads `window.__STREAMBERT_WEB__`).
- Consumes (in Tasks 11): `getDefaultNonAnimeSource` replaces the `NON_ANIME_DEFAULT_SOURCE` constant at call sites.

- [ ] **Step 1: Write the failing test**

`src/utils/defaultSource.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert";
import { defaultNonAnimeSource } from "./defaultSource.mjs";

test("web build defaults to server-extracted VidSrc Direct", () => {
  assert.equal(defaultNonAnimeSource(true), "vidsrc-direct");
});
test("desktop defaults to the plain vidsrc embed (no direct resolver there)", () => {
  assert.equal(defaultNonAnimeSource(false), "vidsrc");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/utils/defaultSource.test.mjs
```
Expected: FAIL — cannot find module `./defaultSource.mjs`.

- [ ] **Step 3: Write the pure module**

`src/utils/defaultSource.mjs`:
```js
// Web-only: vidsrc-direct is server-extracted and has no desktop resolver, so
// it can only be the default in the web build.
export function defaultNonAnimeSource(isWeb) {
  return isWeb ? "vidsrc-direct" : "vidsrc";
}
```

- [ ] **Step 4: Wire it into `api.js`**

In `src/utils/api.js`, add an import at the top (with the other imports) and a window-reading wrapper near the `NON_ANIME_DEFAULT_SOURCE` export (line ~472). Keep the existing `NON_ANIME_DEFAULT_SOURCE` export for backward-compat but add:
```js
import { defaultNonAnimeSource } from "./defaultSource.mjs";

// Reads the runtime web flag; call at render time (not module load) so the
// web shim has already set window.__STREAMBERT_WEB__.
export const getDefaultNonAnimeSource = () =>
  defaultNonAnimeSource(typeof window !== "undefined" && !!window.__STREAMBERT_WEB__);
```
Then flip VidSrc Direct's progress flag: in the `vidsrc-direct` entry of `PLAYER_SOURCES` (around line 179) change `supportsProgress: false` to `supportsProgress: true`.

- [ ] **Step 5: Run test + build to verify**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/utils/defaultSource.test.mjs
npm run build
```
Expected: test PASS; `npm run build` completes with no error (Vite resolves the new `.mjs` import).

- [ ] **Step 6: Commit**

```bash
git add src/utils/defaultSource.mjs src/utils/defaultSource.test.mjs src/utils/api.js
git commit -m "feat(player): web-only vidsrc-direct default + enable its progress flag"
```

---

## Task 5: useVideoController hook

**Files:**
- Create: `src/components/player/useVideoController.js`

**Interfaces:**
- Consumes: `initialVideoState`, `reduceVideo` (Task 2).
- Produces: `useVideoController(videoRef, { wrapRef, onToggleCaptions })->{ state, actions }`. `actions = { togglePlay, seek(t), seekBy(d), setVolume(v), volumeBy(d), toggleMute, setRate(r), toggleFullscreen }`. `state` is the reducer state.

- [ ] **Step 1: Write the hook**

`src/components/player/useVideoController.js`:
```js
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
```

- [ ] **Step 2: Verify it builds**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: build completes with no error. (No React test runner exists; correctness is verified end-to-end in Task 11.)

- [ ] **Step 3: Commit**

```bash
git add src/components/player/useVideoController.js
git commit -m "feat(player): useVideoController hook (element events -> state + actions)"
```

---

## Task 6: VideoControls bar component

**Files:**
- Create: `src/components/player/VideoControls.jsx`

**Interfaces:**
- Consumes: `formatTime` (Task 1); `state` + `actions` shape (Task 5); subtitle menu shape from Task 9 (`{ tracks:[{id,label}], current, select(id), off() }`) passed as `subs` (optional, may be null).
- Produces: `<VideoControls state actions subs visible onActivity />` — a positioned overlay; calls `onActivity()` on pointer move to reset the auto-hide timer (timer lives in WebMediaPlayer, Task 7).

- [ ] **Step 1: Write the component**

`src/components/player/VideoControls.jsx`:
```js
import { useState } from "react";
import { formatTime } from "./format.mjs";

const bar = {
  position: "absolute", left: 0, right: 0, bottom: 0, padding: "8px 12px 10px",
  background: "linear-gradient(transparent, rgba(0,0,0,0.75))",
  display: "flex", flexDirection: "column", gap: 6, zIndex: 15,
  transition: "opacity 0.2s", fontSize: 13, color: "#fff",
};
const row = { display: "flex", alignItems: "center", gap: 14 };
const btn = { background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 2 };

export default function VideoControls({ state, actions, subs, visible }) {
  const [menu, setMenu] = useState(null); // "cc" | "speed" | null
  const { current, duration, bufferedEnd, playing, muted, volume } = state;
  const pct = duration ? (current / duration) * 100 : 0;
  const buf = duration ? (bufferedEnd / duration) * 100 : 0;

  const onScrub = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    actions.seek(((e.clientX - r.left) / r.width) * duration);
  };

  return (
    <div style={{ ...bar, opacity: visible ? 1 : 0, pointerEvents: visible ? "auto" : "none" }}>
      {/* scrub bar */}
      <div onClick={onScrub} style={{ position: "relative", height: 5, borderRadius: 3, background: "rgba(255,255,255,0.25)", cursor: "pointer" }}>
        <div style={{ position: "absolute", inset: 0, width: `${buf}%`, background: "rgba(255,255,255,0.35)", borderRadius: 3 }} />
        <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: "var(--accent, #e50914)", borderRadius: 3 }} />
      </div>
      <div style={row}>
        <button style={btn} onClick={actions.togglePlay} title="Play/Pause (space)">{playing ? "❚❚" : "►"}</button>
        <button style={btn} onClick={() => actions.seekBy(-10)} title="Back 10s">⏪</button>
        <button style={btn} onClick={() => actions.seekBy(10)} title="Forward 10s">⏩</button>
        <button style={btn} onClick={actions.toggleMute} title="Mute (m)">{muted || volume === 0 ? "🔇" : "🔊"}</button>
        <span style={{ opacity: 0.9, fontVariantNumeric: "tabular-nums" }}>
          {formatTime(current)} / {formatTime(duration)}
        </span>
        <span style={{ flex: 1 }} />
        {subs && (
          <div style={{ position: "relative" }}>
            <button style={btn} onClick={() => setMenu(menu === "cc" ? null : "cc")} title="Subtitles (c)">CC</button>
            {menu === "cc" && (
              <div style={{ position: "absolute", bottom: "120%", right: 0, background: "rgba(20,20,20,0.97)", borderRadius: 6, padding: 6, minWidth: 140, maxHeight: 200, overflowY: "auto" }}>
                <div style={{ padding: "4px 8px", cursor: "pointer", opacity: subs.current ? 0.7 : 1 }} onClick={() => { subs.off(); setMenu(null); }}>Off</div>
                {subs.tracks.map((t) => (
                  <div key={t.id} style={{ padding: "4px 8px", cursor: "pointer", opacity: subs.current === t.id ? 1 : 0.7 }} onClick={() => { subs.select(t.id); setMenu(null); }}>{t.label}</div>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ position: "relative" }}>
          <button style={btn} onClick={() => setMenu(menu === "speed" ? null : "speed")} title="Speed">⚙</button>
          {menu === "speed" && (
            <div style={{ position: "absolute", bottom: "120%", right: 0, background: "rgba(20,20,20,0.97)", borderRadius: 6, padding: 6 }}>
              {[0.5, 1, 1.25, 1.5, 2].map((r) => (
                <div key={r} style={{ padding: "4px 12px", cursor: "pointer" }} onClick={() => { actions.setRate(r); setMenu(null); }}>{r}×</div>
              ))}
            </div>
          )}
        </div>
        <button style={btn} onClick={actions.toggleFullscreen} title="Fullscreen (f)">⛶</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it builds**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: build completes with no error.

- [ ] **Step 3: Commit**

```bash
git add src/components/player/VideoControls.jsx
git commit -m "feat(player): app-styled VideoControls overlay bar"
```

---

## Task 7: Render controls in WebMediaPlayer + auto-hide + fullscreen

**Files:**
- Modify: `src/components/WebPlayer.jsx` (`WebMediaPlayer`, lines ~55–130)

**Interfaces:**
- Consumes: `useVideoController` (Task 5), `VideoControls` (Task 6).
- Produces: `WebMediaPlayer` now accepts `wrapRef` (a ref to the fullscreen target, passed from the page) in addition to existing props. Still renders the `<video>` (now without `controls`).

- [ ] **Step 1: Update WebMediaPlayer**

In `src/components/WebPlayer.jsx`, add imports at top:
```js
import { useVideoController } from "./player/useVideoController";
import VideoControls from "./player/VideoControls";
```
Change the `WebMediaPlayer` signature to accept `wrapRef` and (placeholder for later tasks) `subs`:
```js
export function WebMediaPlayer({ src, referer, startTime = 0, hidden, onReady, wrapRef, subs = null }) {
```
Inside the component body, after the existing `useEffect`, add controller + auto-hide state:
```js
  const { state, actions } = useVideoController(videoRef, {
    wrapRef,
    onToggleCaptions: () => subs && (subs.current ? subs.off() : subs.tracks[0] && subs.select(subs.tracks[0].id)),
  });
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef(null);
  const poke = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);
```
Add `useState`, `useCallback` to the existing React import line. Then change the render: remove `controls` from the `<video>`, wrap the return in a fragment that adds a pointer-move catcher and the bar:
```js
  return (
    <>
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
      />
      <div onMouseMove={poke} onTouchStart={poke}
           style={{ position: "absolute", inset: 0, zIndex: 14, pointerEvents: hidden ? "none" : "auto" }}
           onClick={actions.togglePlay} />
      {!hidden && <VideoControls state={state} actions={actions} subs={subs} visible={controlsVisible} />}
    </>
  );
```
Note: the transparent catcher forwards clicks to play/pause; the bar sits above it (`zIndex 15 > 14`) so its buttons still work.

- [ ] **Step 2: Verify it builds**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: build completes with no error.

- [ ] **Step 3: Commit**

```bash
git add src/components/WebPlayer.jsx
git commit -m "feat(player): render custom controls + auto-hide on native player"
```

---

## Task 8: Progress saving + resume hook

**Files:**
- Create: `src/components/player/useProgressSaver.js`
- Modify: `src/components/WebPlayer.jsx` (call the hook in `WebMediaPlayer`)

**Interfaces:**
- Consumes: `toPct`, `shouldSave`, `isWatched` (Task 1).
- Produces: `useProgressSaver({ videoRef, active, progressKey, onSaveProgress, onMarkWatched, watchedThreshold, storage })`. Wires `timeupdate` (throttled) + a `pagehide` beacon.
- WebMediaPlayer gains props: `progressKey, onSaveProgress, onMarkWatched, watchedThreshold, storage`.

- [ ] **Step 1: Write the hook**

`src/components/player/useProgressSaver.js`:
```js
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
    const onLeave = () => {
      const { currentTime: ct, duration: dur } = v;
      if (dur > 0 && navigator.sendBeacon) {
        navigator.sendBeacon("/api/state/progress/beacon",
          JSON.stringify({ key: progressKey, pct: toPct(ct, dur) }));
      }
    };
    v.addEventListener("timeupdate", onTime);
    window.addEventListener("pagehide", onLeave);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [videoRef, active, progressKey, onSaveProgress, onMarkWatched, watchedThreshold, storage]);
}
```

- [ ] **Step 2: Wire into WebMediaPlayer**

In `src/components/WebPlayer.jsx`, import and call it. Add to imports:
```js
import { useProgressSaver } from "./player/useProgressSaver";
```
Extend the signature with the new props and call the hook (after `useVideoController`):
```js
export function WebMediaPlayer({ src, referer, startTime = 0, hidden, onReady, wrapRef, subs = null,
  progressKey, onSaveProgress, onMarkWatched, watchedThreshold, storage }) {
  ...
  useProgressSaver({ videoRef, active: !hidden && !!src, progressKey, onSaveProgress, onMarkWatched, watchedThreshold, storage });
```

- [ ] **Step 3: Verify it builds**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: build completes with no error.

- [ ] **Step 4: Commit**

```bash
git add src/components/player/useProgressSaver.js src/components/WebPlayer.jsx
git commit -m "feat(player): resume + throttled progress saving on native player"
```

---

## Task 9: Subtitles hook + track attach

**Files:**
- Create: `src/components/player/useSubtitles.js`
- Modify: `src/components/WebPlayer.jsx` (call hook, pass `subs` into the existing `subs` prop path, render `<track>`)

**Interfaces:**
- Consumes: `window.electron.searchSubtitles`, `window.electron.getSubtitleUrl`, `secureStorage` keys (mirrors `SubtitleDownloaderModal.jsx:63-70`).
- Produces: `useSubtitles({ active, tmdbId, mediaType, season, episode })->{ tracks:[{id,label}], current:id|null, url:string|null, select(id), off() }`. WebMediaPlayer passes this object down as `subs` and renders a `<track>` for the active cue URL.

- [ ] **Step 1: Write the hook**

`src/components/player/useSubtitles.js`:
```js
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
```

- [ ] **Step 2: Wire into WebMediaPlayer**

In `src/components/WebPlayer.jsx`: import `useSubtitles`, drop the `subs = null` prop and instead build it internally from new id props, render a `<track>` inside the `<video>` when a URL is chosen. Add to imports:
```js
import { useSubtitles } from "./player/useSubtitles";
```
Change signature: replace `subs = null` with `tmdbId, mediaType, season, episode`. Build subs. **Ordering matters:** place `useSubtitles(...)` and the `const subs = ...` line **above** the `useVideoController(...)` call, because `onToggleCaptions` (Task 7) closes over `subs` — if `subs` is declared after the hook call it throws a temporal-dead-zone `ReferenceError`.
```js
  const subsCtl = useSubtitles({ active: !hidden && !!src, tmdbId, mediaType, season, episode });
  const subs = subsCtl.tracks.length ? subsCtl : null;
```
Add a `<track>` child to the `<video>` element (default track only when a URL exists — proxy it):
```js
        {subsCtl.url && (
          <track kind="subtitles" default src={toMediaSrc(subsCtl.url, referer)} srcLang="sub" label="Subtitles" />
        )}
```
(Place the `<track>` between the `<video ...>` open tag props and its close — i.e. give `<video>` children; it currently self-closes, so convert to `<video ...>{subsCtl.url && (<track .../>)}</video>`.)

- [ ] **Step 3: Verify it builds**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: build completes with no error.

- [ ] **Step 4: Commit**

```bash
git add src/components/player/useSubtitles.js src/components/WebPlayer.jsx
git commit -m "feat(player): subtitle search + track attach on native player"
```

---

## Task 10: Keyboard shortcuts hook

**Files:**
- Create: `src/components/player/useKeyboardShortcuts.js`
- Modify: `src/components/WebPlayer.jsx` (call hook in `WebMediaPlayer`)

**Interfaces:**
- Consumes: `keyToAction` (Task 3), `actions` (Task 5).
- Produces: `useKeyboardShortcuts({ active, actions })` — a `window` keydown listener that maps keys to `actions` and calls `preventDefault` on handled keys.

- [ ] **Step 1: Write the hook**

`src/components/player/useKeyboardShortcuts.js`:
```js
import { useEffect } from "react";
import { keyToAction } from "./keymap.mjs";

const isTyping = (el) =>
  !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

export function useKeyboardShortcuts({ active, actions }) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      const action = keyToAction(e.key, { typingInInput: isTyping(document.activeElement) });
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case "togglePlay": return actions.togglePlay();
        case "seekBy": return actions.seekBy(action.delta);
        case "volumeBy": return actions.volumeBy(action.delta);
        case "toggleFullscreen": return actions.toggleFullscreen();
        case "toggleMute": return actions.toggleMute();
        case "toggleCaptions": return actions.toggleCaptions();
        default: return undefined;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, actions]);
}
```

- [ ] **Step 2: Wire into WebMediaPlayer**

In `src/components/WebPlayer.jsx`, add import and call after the controller:
```js
import { useKeyboardShortcuts } from "./player/useKeyboardShortcuts";
...
  useKeyboardShortcuts({ active: !hidden && !!src, actions });
```

- [ ] **Step 3: Verify it builds**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
npm run build
```
Expected: build completes with no error.

- [ ] **Step 4: Commit**

```bash
git add src/components/player/useKeyboardShortcuts.js src/components/WebPlayer.jsx
git commit -m "feat(player): keyboard shortcuts on native player"
```

---

## Task 11: Integrate into pages + default source + manual verification

**Files:**
- Modify: `src/pages/MoviePage.jsx` (WebMediaPlayer call ~973-981; default source imports/usage lines 25, 89, 297; add `wrapRef` = existing `playerWrapRef`)
- Modify: `src/pages/TVPage.jsx` (WebMediaPlayer call; default source lines 32, 394, 670; season/episode props)

**Interfaces:**
- Consumes: `getDefaultNonAnimeSource` (Task 4), extended `WebMediaPlayer` props (Tasks 7–10).

- [ ] **Step 1: Swap the default-source constant in MoviePage**

In `src/pages/MoviePage.jsx`:
- In the import from `../utils/api` (line ~25), replace `NON_ANIME_DEFAULT_SOURCE` with `getDefaultNonAnimeSource`.
- Line ~89: `() => storage.get("playerSource") || getDefaultNonAnimeSource(),`
- Line ~297: `setPlayerSource(!savedSrc?.tag ? saved : getDefaultNonAnimeSource());`

- [ ] **Step 2: Pass the new props to WebMediaPlayer in MoviePage**

Replace the `<WebMediaPlayer .../>` block (lines ~974-980) with:
```js
                  <WebMediaPlayer
                    src={webMedia.url}
                    referer={webMedia.referer}
                    startTime={webMedia.startTime}
                    hidden={webviewLoading}
                    onReady={() => setWebviewLoading(false)}
                    wrapRef={playerWrapRef}
                    progressKey={progressKey}
                    onSaveProgress={saveProgress}
                    onMarkWatched={onMarkWatched}
                    watchedThreshold={watchedThreshold}
                    storage={storage}
                    tmdbId={String(item.id)}
                    mediaType="movie"
                  />
```
(`saveProgress`, `watchedThreshold`, `storage`, `playerWrapRef`, `onMarkWatchedRef` all already exist in this component.)

- [ ] **Step 3: Mirror in TVPage**

In `src/pages/TVPage.jsx`: same default-source import/usage swap (lines ~32, 394, 670), and pass the same props to its `WebMediaPlayer`, plus `mediaType="tv"`, `season={selectedSeason}`, `episode={epNum}`, and the TV page's `progressKey` for the episode. Use that page's existing `playerWrapRef`, `saveProgress`, `watchedThreshold`, `storage`, and mark-watched ref (match the names already in TVPage — grep `playerWrapRef`, `saveProgress`, `onMarkWatched` there).

- [ ] **Step 4: Full build + test suite green**

```bash
export PATH="/home/philip/.nvm/versions/node/v20.20.2/bin:$PATH"
node --test src/components/player/*.test.mjs src/utils/defaultSource.test.mjs
npm run build
```
Expected: all pure tests `# fail 0`; build completes with no error.

- [ ] **Step 5: Manual verification pass (web build)**

Serve the built app and log in, then confirm on a **movie** (VidSrc Direct default):
1. Playback starts in the native player with the **custom bar** (not the gray browser bar).
2. Bar auto-hides after ~3s idle and returns on mouse-move.
3. **Fullscreen button works** (wrapper goes fullscreen, bar stays visible).
4. Reload mid-movie → resumes near the last position.
5. Keyboard: space toggles play, ←/→ seek, ↑/↓ volume, `f` fullscreen, `m` mute.
6. **CC** menu lists languages; selecting one shows subtitles; "Off" hides them.
7. Repeat one check on a **TV episode**.
8. Force an extraction failure (or pick Videasy) → the **embed** still shows its own controls (unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/pages/MoviePage.jsx src/pages/TVPage.jsx
git commit -m "feat(player): default web non-anime to VidSrc Direct + wire native player props"
```

---

## Notes for the implementer

- The desktop Electron `<webview>` branches in both pages are **not** touched — only the `window.__STREAMBERT_WEB__` `WebMediaPlayer` path.
- If `npm run build` complains about an unused `NON_ANIME_DEFAULT_SOURCE` import somewhere, remove that specific import — it is superseded by `getDefaultNonAnimeSource`.
- Subtitle URL resolution (`getSubtitleUrl`) may return a provider URL or a local path; if a selected track does not render in the manual pass, log `subsCtl.url` and confirm it is a `.vtt` reachable through `/api/proxy` — this is the one integration point without a unit test.
