// Vercel serverless function (static deployment only — the full server build
// has its own /api/secure route; this directory is ignored by it).
//
// Serves the admin-configured TMDB Read Access Token so visitors skip the
// token setup screen, mirroring the server deployment's env fallback
// (server/routes/secure.js). Without the env var this 404s, which makes the
// web shim latch its localStorage fallback — the pre-function behavior.
export default function handler(req, res) {
  const value = process.env.STREAMBERT_TMDB_TOKEN;
  if (!value || req.method !== "GET") {
    res.status(404).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ value });
}
