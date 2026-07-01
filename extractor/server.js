"use strict";
const http = require("http");
const { extractStream, NoStreamError, TimeoutError } = require("./extract");

async function handleExtract(body, deps) {
  const run = (deps && deps.extractStream) || extractStream;
  const { tmdb, type, season, episode } = body || {};
  if (!tmdb || (type !== "movie" && type !== "tv")) return { status: 400, json: { error: "tmdb and type(movie|tv) required" } };
  if (type === "tv" && (season == null || episode == null)) return { status: 400, json: { error: "season and episode required for tv" } };
  try {
    const { m3u8, referer } = await run({ tmdb: String(tmdb), type, season, episode });
    return { status: 200, json: { m3u8, referer } };
  } catch (e) {
    if (e instanceof TimeoutError || e.name === "TimeoutError") return { status: 504, json: { error: "extract timeout" } };
    if (e instanceof NoStreamError || e.name === "NoStreamError") return { status: 404, json: { error: "no stream" } };
    return { status: 500, json: { error: "extract failed" } };
  }
}

function start(port = Number(process.env.PORT) || 8788) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true })); }
    if (req.method === "POST" && req.url === "/extract") {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", async () => {
        let body; try { body = JSON.parse(b || "{}"); } catch { body = {}; }
        const { status, json } = await handleExtract(body);
        res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(json));
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  server.listen(port, () => console.log(`extractor listening on ${port}`));
  return server;
}

if (require.main === module) start();
module.exports = { handleExtract, start };
