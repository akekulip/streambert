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
