import { useState, useRef, useEffect } from "react";
import { StreambertLogo, PlayIcon } from "./Icons";
import { login } from "../utils/session";

// Looks like an email address, or has enough digits to pass for a phone number.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const looksLikeIdentifier = (v) =>
  EMAIL_RE.test(v) || v.replace(/[^0-9]/g, "").length >= 7;

// Full-screen username+password gate for the self-hosted web build. Posts to
// POST /api/login {username, password} and reloads on success so the signed
// cookie is picked up by every subsequent /api call. Also offers a
// self-registration mode (POST /api/register {identifier, password}) for
// creating a new account, which then waits on admin approval.
export default function LoginGate({ onSuccess }) {
  const [mode, setMode] = useState("login"); // "login" | "register"

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const userRef = useRef(null);

  const [identifier, setIdentifier] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [regChecking, setRegChecking] = useState(false);
  const [regError, setRegError] = useState(null);
  const [registered, setRegistered] = useState(false);
  const identifierRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => {
      (mode === "login" ? userRef : identifierRef).current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [mode]);

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

  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setRegError(null);
  };

  const handleRegisterSubmit = async () => {
    if (!identifier || !regPassword || !confirmPassword || regChecking) return;
    if (!looksLikeIdentifier(identifier)) {
      setRegError("Enter a valid email address or phone number.");
      return;
    }
    if (regPassword.length < 8) {
      setRegError("Password must be at least 8 characters.");
      return;
    }
    if (regPassword !== confirmPassword) {
      setRegError("Passwords do not match.");
      return;
    }
    setRegChecking(true);
    setRegError(null);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ identifier, password: regPassword }),
      });
      if (res.ok) {
        setRegistered(true);
      } else {
        const j = await res.json().catch(() => ({}));
        setRegError(j.error || "Registration failed");
      }
    } catch {
      setRegError("Cannot reach the server. Check your connection.");
    } finally {
      setRegChecking(false);
    }
  };

  if (mode === "register") {
    return (
      <div className="apikey-modal">
        <div className="apikey-box">
          <div className="apikey-logo">
            <StreambertLogo />
          </div>
          <div className="apikey-title">STREAMBERT</div>

          {registered ? (
            <>
              <p className="apikey-sub">
                Account created — an admin will approve it shortly. You can
                log in once approved.
              </p>
              <a
                className="apikey-link"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setRegistered(false);
                  switchMode("login");
                }}
              >
                Back to sign in
              </a>
            </>
          ) : (
            <>
              <p className="apikey-sub">Create an account.</p>
              <input
                className={`apikey-input${regError ? " apikey-input-error" : ""}`}
                placeholder="Email or phone number"
                autoComplete="username"
                value={identifier}
                onChange={(e) => { setIdentifier(e.target.value); setRegError(null); }}
                onKeyDown={(e) => e.key === "Enter" && !regChecking && handleRegisterSubmit()}
                ref={identifierRef}
                disabled={regChecking}
              />
              <input
                type="password"
                className={`apikey-input${regError ? " apikey-input-error" : ""}`}
                placeholder="Password"
                autoComplete="new-password"
                value={regPassword}
                onChange={(e) => { setRegPassword(e.target.value); setRegError(null); }}
                onKeyDown={(e) => e.key === "Enter" && !regChecking && handleRegisterSubmit()}
                disabled={regChecking}
                style={{ marginTop: 10 }}
              />
              <input
                type="password"
                className={`apikey-input${regError ? " apikey-input-error" : ""}`}
                placeholder="Confirm password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setRegError(null); }}
                onKeyDown={(e) => e.key === "Enter" && !regChecking && handleRegisterSubmit()}
                disabled={regChecking}
                style={{ marginTop: 10 }}
              />

              {regError && (
                <div className="apikey-error-box">
                  <div className="apikey-error-title">⚠ Registration failed</div>
                  <div className="apikey-error-body">{regError}</div>
                </div>
              )}

              <button
                className="btn btn-primary"
                style={{ width: "100%", justifyContent: "center", padding: "13px", marginTop: regError ? 0 : 12 }}
                onClick={handleRegisterSubmit}
                disabled={!identifier || !regPassword || !confirmPassword || regChecking}
              >
                {regChecking ? (<><span className="apikey-spinner" /> Creating account…</>) : (<><PlayIcon /> Create account</>)}
              </button>

              <p className="apikey-sub" style={{ marginTop: 16, marginBottom: 0 }}>
                <a
                  className="apikey-link"
                  href="#"
                  onClick={(e) => { e.preventDefault(); switchMode("login"); }}
                >
                  Back to sign in
                </a>
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

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

        <p className="apikey-sub" style={{ marginTop: 16, marginBottom: 0 }}>
          <a
            className="apikey-link"
            href="#"
            onClick={(e) => { e.preventDefault(); switchMode("register"); }}
          >
            Create an account
          </a>
        </p>
      </div>
    </div>
  );
}
