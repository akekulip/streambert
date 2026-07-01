import { useEffect, useState } from "react";

// Admin-only user management. Rendered inside Settings when me.role === "admin".
export default function UsersAdminPanel() {
  const [users, setUsers] = useState([]);
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newRole, setNewRole] = useState("user");
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (res.ok) setUsers(await res.json());
      else setMsg(`Failed to load users (HTTP ${res.status})`);
    } catch {
      setMsg("Failed to load users — is the server reachable?");
    }
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

  return (
    <div>
      <h3>Users</h3>
      {msg && <div style={{ color: "var(--text2)", marginBottom: 8 }}>{msg}</div>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {users.map((u) => (
          <li key={u.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
            <span style={{ flex: 1 }}>{u.username} <em style={{ color: "var(--text3)" }}>({u.role})</em></span>
            <button className="btn" onClick={() => resetPass(u.id)}>Reset password</button>
            <button className="btn" onClick={() => removeUser(u.id)}>Delete</button>
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
