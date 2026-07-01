import { useState, useRef, useEffect } from "react";
import { StreambertLogo, PlayIcon } from "./Icons";
import { login } from "../utils/session";

// Full-screen username+password gate for the self-hosted web build. Posts to
// POST /api/login {username, password} and reloads on success so the signed
// cookie is picked up by every subsequent /api call.
export default function LoginGate({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const userRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => userRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = async () => {
    if (!username || !password || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await login(username, password);
      if (res.ok) {
        onSuccess();
        return;
      }
      setError(
        res.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : res.status === 401
            ? "Invalid username or password."
            : `Sign-in failed (HTTP ${res.status}).`,
      );
    } catch {
      setError("Cannot reach the server. Check your connection.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="apikey-modal">
      <div className="apikey-box">
        <div className="apikey-logo">
          <StreambertLogo />
        </div>
        <div className="apikey-title">STREAMBERT</div>
        <p className="apikey-sub">Sign in to your account.</p>
        <input
          className={`apikey-input${error ? " apikey-input-error" : ""}`}
          placeholder="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => { setUsername(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && !checking && handleSubmit()}
          ref={userRef}
          disabled={checking}
        />
        <input
          type="password"
          className={`apikey-input${error ? " apikey-input-error" : ""}`}
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && !checking && handleSubmit()}
          disabled={checking}
          style={{ marginTop: 10 }}
        />

        {error && (
          <div className="apikey-error-box">
            <div className="apikey-error-title">⚠ Sign-in failed</div>
            <div className="apikey-error-body">{error}</div>
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "13px", marginTop: error ? 0 : 12 }}
          onClick={handleSubmit}
          disabled={!username || !password || checking}
        >
          {checking ? (<><span className="apikey-spinner" /> Signing in…</>) : (<><PlayIcon /> Sign in</>)}
        </button>
      </div>
    </div>
  );
}
