import { useEffect, useState, useCallback } from "react";

// Admin analytics + health dashboard (rendered above UsersAdminPanel in
// Settings for admins). Data: /api/admin/analytics and /api/admin/health.

const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString() : "never");
const fmtDay = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// Single-series daily activity bars. One series → the title names it, no
// legend; native <title> tooltips per bar; recessive baseline + endpoint
// labels only; selective max label instead of a number on every bar.
function ActivityBars({ data }) {
  const W = 600;
  const H = 110;
  const PAD_TOP = 16;
  const BASE = H - 18;
  const max = Math.max(1, ...data.map((d) => d.count));
  const step = W / data.length;
  const barW = Math.max(2, step - 2); // 2px surface gap between bars
  const maxIdx = data.findIndex((d) => d.count === max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Watch activity per day">
      <line x1="0" y1={BASE} x2={W} y2={BASE} stroke="var(--text3)" strokeOpacity="0.35" strokeWidth="1" />
      {data.map((d, i) => {
        if (d.count === 0) return null;
        const h = Math.max(2, ((BASE - PAD_TOP) * d.count) / max);
        return (
          <rect
            key={d.day}
            x={i * step + 1}
            y={BASE - h}
            width={barW}
            height={h}
            rx="2"
            fill="var(--accent, #e50914)"
          >
            <title>{`${fmtDay(d.day)} — ${d.count} ${d.count === 1 ? "watch" : "watches"}`}</title>
          </rect>
        );
      })}
      {maxIdx >= 0 && data[maxIdx].count > 0 && (
        <text
          x={Math.min(W - 14, Math.max(14, maxIdx * step + step / 2))}
          y={PAD_TOP - 5 + 0}
          textAnchor="middle"
          fill="var(--text2)"
          fontSize="11"
        >
          {data[maxIdx].count}
        </text>
      )}
      <text x="2" y={H - 4} fill="var(--text3)" fontSize="10">{fmtDay(data[0].day)}</text>
      <text x={W - 2} y={H - 4} textAnchor="end" fill="var(--text3)" fontSize="10">
        {fmtDay(data[data.length - 1].day)}
      </text>
    </svg>
  );
}

// Two-segment split with direct labels — identity is carried by the labels,
// never by color alone.
function TypeSplit({ movie, tv }) {
  const total = movie + tv;
  if (!total) return null;
  const moviePct = Math.round((movie / total) * 100);
  return (
    <div>
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 2 }}>
        <div style={{ width: `${moviePct}%`, background: "var(--accent, #e50914)" }} />
        <div style={{ flex: 1, background: "var(--text3)" }} />
      </div>
      <div style={{ color: "var(--text2)", fontSize: "0.85em", marginTop: 4 }}>
        Movies {movie} ({moviePct}%) · Series {tv} ({100 - moviePct}%)
      </div>
    </div>
  );
}

const tile = { padding: "10px 14px", background: "var(--bg2, rgba(255,255,255,0.04))", borderRadius: 8 };
const tileNum = { fontSize: "1.6em", fontWeight: 600 };
const tileLabel = { color: "var(--text3)", fontSize: "0.8em" };

export default function AdminDashboard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/analytics?days=${days}`, { credentials: "include" });
      if (res.ok) setData(await res.json());
    } catch { /* leave previous data */ }
    try {
      const res = await fetch("/api/admin/health", { credentials: "include" });
      if (res.ok) setHealth(await res.json());
    } catch { /* leave previous health */ }
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const runCanary = async () => {
    setBusy(true);
    try {
      await fetch("/api/admin/health/canary", { method: "POST", credentials: "include" });
      await load();
    } catch { /* surfaced by stale card */ }
    setBusy(false);
  };

  const canary = health?.canary;
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Activity</h3>
        <div style={{ display: "flex", gap: 4 }}>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className="btn"
              onClick={() => setDays(d)}
              style={days === d ? { outline: "1px solid var(--accent, #e50914)" } : undefined}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {data ? (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={tile}>
              <div style={tileNum}>{data.totals.watches}</div>
              <div style={tileLabel}>watches in {data.days}d</div>
            </div>
            <div style={tile}>
              <div style={tileNum}>{data.totals.activeUsers7d}</div>
              <div style={tileLabel}>active users (7d)</div>
            </div>
            <div style={{ ...tile, flex: 1, minWidth: 160 }}>
              <TypeSplit movie={data.typeSplit.movie} tv={data.typeSplit.tv} />
            </div>
          </div>

          <ActivityBars data={data.watchesPerDay} />

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12 }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <h4 style={{ margin: "0 0 6px" }}>Top titles</h4>
              {data.topTitles.length === 0 && <div style={{ color: "var(--text3)" }}>No watches yet.</div>}
              {data.topTitles.map((t) => (
                <div key={`${t.media_type}_${t.tmdb_id}`} style={{ display: "flex", gap: 8, padding: "2px 0", color: "var(--text2)" }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title || `${t.media_type} #${t.tmdb_id}`}
                  </span>
                  <span>{t.count}</span>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <h4 style={{ margin: "0 0 6px" }}>Most active</h4>
              {data.activeUsers.length === 0 && <div style={{ color: "var(--text3)" }}>No activity yet.</div>}
              {data.activeUsers.map((u) => (
                <div key={u.username} style={{ display: "flex", gap: 8, padding: "2px 0", color: "var(--text2)" }}>
                  <span style={{ flex: 1 }}>{u.username}</span>
                  <span>{u.count}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div style={{ color: "var(--text3)" }}>Loading analytics…</div>
      )}

      <h4 style={{ margin: "16px 0 6px" }}>Stream extraction health</h4>
      <div style={{ ...tile, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        {canary && canary.last ? (
          <>
            <span style={{ color: "var(--text2)" }}>
              {canary.last.ok ? "✓ Passing" : "✕ FAILING"} · {canary.last.ms}ms
              {canary.last.error ? ` · ${canary.last.error}` : ""}
            </span>
            <span style={{ color: "var(--text3)", fontSize: "0.85em" }}>
              checked {fmtWhen(canary.last.at)}
              {canary.passRate != null ? ` · ${Math.round(canary.passRate * 100)}% of last ${canary.history.length}` : ""}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--text3)" }}>No canary runs yet.</span>
        )}
        <button className="btn" onClick={runCanary} disabled={busy}>
          {busy ? "Running…" : "Run check now"}
        </button>
      </div>
    </div>
  );
}
