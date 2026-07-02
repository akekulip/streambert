import { useEffect, useState } from "react";

// Shown full-screen when the logged-in account is not active. Offers WhatsApp /
// Telegram links (from /api/config) so the user can ask the admin to approve.
export default function PendingScreen({ status, onLogout }) {
  const [links, setLinks] = useState({ whatsapp: null, telegram: null });
  useEffect(() => {
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.json()).then(setLinks).catch(() => {});
  }, []);
  const suspended = status === "disabled";
  const box = { position: "fixed", inset: 0, display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 18, textAlign: "center",
    background: "var(--bg1, #0b0b0b)", color: "var(--text1, #fff)", padding: 24 };
  const btn = { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px",
    borderRadius: 8, textDecoration: "none", fontWeight: 600, color: "#fff" };
  return (
    <div style={box}>
      <h1 style={{ margin: 0 }}>{suspended ? "Account suspended" : "Awaiting approval"}</h1>
      <p style={{ maxWidth: 420, color: "var(--text2, #bbb)", margin: 0 }}>
        {suspended
          ? "Your account has been suspended. Contact the admin if you think this is a mistake."
          : "Your account was created and is waiting for an admin to approve it. Message the admin to get activated:"}
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        {links.whatsapp && <a style={{ ...btn, background: "#25D366" }} href={links.whatsapp} target="_blank" rel="noreferrer">WhatsApp</a>}
        {links.telegram && <a style={{ ...btn, background: "#229ED9" }} href={links.telegram} target="_blank" rel="noreferrer">Telegram</a>}
      </div>
      <button className="btn" onClick={onLogout} style={{ marginTop: 8 }}>Log out</button>
    </div>
  );
}
