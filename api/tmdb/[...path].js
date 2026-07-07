// Vercel serverless function (static deployment only).
//
// Same-origin TMDB proxy: the frontend's tmdbFetch tries /api/tmdb first, so
// with this in place most metadata traffic runs through the server-side token
// and Vercel's CDN cache instead of the token handed to the client. Returns
// 404 when the env var is missing, which makes tmdbFetch latch direct mode.
export default async function handler(req, res) {
  const token = process.env.STREAMBERT_TMDB_TOKEN;
  if (!token || req.method !== "GET") {
    res.status(404).end();
    return;
  }
  // Browser calls from the app are same-origin; refuse other sites hotlinking
  // the proxy from their pages. Best-effort only (curl sends no such header).
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    res.status(403).end();
    return;
  }
  const path = req.url.replace(/^\/api\/tmdb/, "");
  try {
    const r = await fetch(`https://api.themoviedb.org/3${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await r.text();
    res.setHeader("Content-Type", "application/json");
    if (r.ok) {
      res.setHeader(
        "Cache-Control",
        "public, s-maxage=300, stale-while-revalidate=600",
      );
    }
    res.status(r.status).send(body);
  } catch {
    res.status(502).json({ error: "tmdb_unreachable" });
  }
}
