import { useEffect, useState } from "react";

// Admin-only user management + server insight. Rendered inside Settings when
// me.role === "admin".

const fmtBytes = (b) =>
  b == null ? "—" : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
const fmtUptime = (s) =>
  s == null ? "—" : s > 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`;
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString() : "never");

export default function UsersAdminPanel() {
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [detail, setDetail] = useState(null); // { id, summary, recs, loading }
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newRole, setNewRole] = useState("user");
  const [msg, setMsg] = useState(null);

  const get = (path) =>
    fetch(path, { credentials: "include" }).then((r) =>
      r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
    );

  const load = async () => {
    try {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (res.ok) setUsers(await res.json());
      else setMsg(`Failed to load users (HTTP ${res.status})`);
    } catch {
      setMsg("Failed to load users — is the server reachable?");
    }
    get("/api/admin/stats").then(setStats).catch(() => setStats(null));
  };
  useEffect(() => { load(); }, []);

  const addUser = async () => {
    setMsg(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newName, password: newPass, role: newRole }),
      });
      if (res.ok) { setNewName(""); setNewPass(""); setNewRole("user"); load(); }
      else setMsg((await res.json().catch(() => ({}))).error || `Failed (HTTP ${res.status})`);
    } catch {
      setMsg("Request failed — is the server reachable?");
    }
  };

  const resetPass = async (id) => {
    const pw = window.prompt("New password (min 8 chars):");
    if (!pw) return;
    try {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      setMsg(res.ok ? "Password reset." : ((await res.json().catch(() => ({}))).error || "Failed"));
    } catch {
      setMsg("Request failed — is the server reachable?");
    }
  };

  const removeUser = async (id) => {
    try {
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" });
      if (res.ok) load();
      else setMsg((await res.json().catch(() => ({}))).error || "Failed");
    } catch {
      setMsg("Request failed — is the server reachable?");
    }
  };

  const purgeCaches = async () => {
    try {
      const res = await fetch("/api/admin/recs-cache/purge", { method: "POST", credentials: "include" });
      setMsg(res.ok ? "Caches purged." : "Purge failed");
      load();
    } catch {
      setMsg("Request failed — is the server reachable?");
    }
  };

  const toggleDetail = async (id) => {
    if (detail && detail.id === id) return setDetail(null);
    setDetail({ id, loading: true });
    try {
      const [summary, recs] = await Promise.all([
        get(`/api/admin/users/${id}/summary`),
        get(`/api/admin/users/${id}/recommendations`).catch(() => null),
      ]);
      setDetail({ id, summary, recs, loading: false });
    } catch {
      setDetail(null);
      setMsg("Failed to load user detail");
    }
  };

  return (
    <div>
      <h3>Server</h3>
      {stats ? (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "var(--text2)", marginBottom: 12 }}>
          <span>{stats.users} users</span>
          <span>{stats.rows.history} history rows</span>
          <span>{stats.rows.progress} progress</span>
          <span>{stats.rows.library} library</span>
          <span>DB {fmtBytes(stats.dbSizeBytes)}</span>
          <span>up {fmtUptime(stats.uptimeSec)}</span>
          <span>
            recs cache: {stats.recsCache.users} users
            {stats.recsCache.tmdb ? `, ${stats.recsCache.tmdb.entries} TMDB paths` : ""}
          </span>
          {stats.recsCache.tmdb && (
            <span>
              TMDB hits: {stats.recsCache.tmdb.hits ?? 0}/
              {(stats.recsCache.tmdb.hits ?? 0) + (stats.recsCache.tmdb.misses ?? 0)}
            </span>
          )}
          {stats.streams && (
            <span>streams cached: {stats.streams.entries}</span>
          )}
          {stats.prewarm && (
            <span>
              pre-warmed: {stats.prewarm.warmed}
              {stats.prewarm.errors ? ` (${stats.prewarm.errors} failed)` : ""}
            </span>
          )}
          <button className="btn" onClick={purgeCaches}>Purge caches</button>
        </div>
      ) : (
        <div style={{ color: "var(--text3)", marginBottom: 12 }}>stats unavailable</div>
      )}

      <h3>Users</h3>
      {msg && <div style={{ color: "var(--text2)", marginBottom: 8 }}>{msg}</div>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {users.map((u) => (
          <li key={u.id} style={{ padding: "4px 0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ flex: 1 }}>{u.username} <em style={{ color: "var(--text3)" }}>({u.role})</em></span>
              <button className="btn" onClick={() => toggleDetail(u.id)}>
                {detail && detail.id === u.id ? "Hide" : "Details"}
              </button>
              <button className="btn" onClick={() => resetPass(u.id)}>Reset password</button>
              <button className="btn" onClick={() => removeUser(u.id)}>Delete</button>
            </div>
            {detail && detail.id === u.id && !detail.loading && (
              <div style={{ margin: "6px 0 8px", padding: "8px 12px", background: "var(--bg2, rgba(255,255,255,0.04))", borderRadius: 8, color: "var(--text2)", fontSize: "0.9em" }}>
                <div>
                  {detail.summary.history.c} watched (last {fmtWhen(detail.summary.history.last)}) ·{" "}
                  {detail.summary.progress.c} in progress · {detail.summary.watched.c} marked ·{" "}
                  {detail.summary.library.c} in library
                </div>
                {detail.recs && detail.recs.results.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <strong>Would recommend:</strong>{" "}
                    {detail.recs.results.map((r) => r.title).join(", ")}
                  </div>
                )}
                {detail.recs && detail.recs.results.length === 0 && (
                  <div style={{ marginTop: 6, color: "var(--text3)" }}>
                    No recommendations yet (no watch history).
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <input className="apikey-input" placeholder="username" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input className="apikey-input" type="password" placeholder="initial password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
        <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <button className="btn btn-primary" onClick={addUser} disabled={!newName || !newPass}>Add user</button>
      </div>
    </div>
  );
}
