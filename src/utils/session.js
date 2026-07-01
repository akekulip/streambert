// Auth/session helpers for the web build. All calls are same-origin with the
// session cookie included.
export async function getMe() {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function login(username, password) {
  return fetch("/api/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function logout() {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
  } catch {
    /* ignore */
  }
}
