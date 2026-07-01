import { useState, useRef, useEffect } from "react";
import { StreambertLogo, PlayIcon } from "./Icons";

// Full-screen password gate for the self-hosted web build. Posts to
// POST /api/login {password} with credentials and reloads on success so the
// signed cookie is picked up by every subsequent /api call. Reuses the
// apikey-* styles from SetupScreen for visual consistency.
export default function LoginGate({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = async () => {
    if (!password || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onSuccess();
        return;
      }
      setError(
        res.status === 401
          ? "Incorrect password. Try again."
          : `Sign-in failed (HTTP ${res.status}). Try again.`,
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
        <p className="apikey-sub">Enter your password to continue.</p>
        <input
          type="password"
          className={`apikey-input${error ? " apikey-input-error" : ""}`}
          placeholder="Password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && !checking && handleSubmit()}
          ref={inputRef}
          disabled={checking}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            borderColor: error ? "#f44336" : focused ? "var(--red)" : undefined,
          }}
        />

        {error && (
          <div className="apikey-error-box">
            <div className="apikey-error-title">⚠ Sign-in failed</div>
            <div className="apikey-error-body">{error}</div>
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{
            width: "100%",
            justifyContent: "center",
            padding: "13px",
            marginTop: error ? 0 : undefined,
          }}
          onClick={handleSubmit}
          disabled={!password || checking}
        >
          {checking ? (
            <>
              <span className="apikey-spinner" /> Signing in…
            </>
          ) : (
            <>
              <PlayIcon /> Sign in
            </>
          )}
        </button>
      </div>
    </div>
  );
}
