"use strict";
// Extraction health canary (roadmap ③). VidSrc rotates its rcp host and
// obfuscation periodically (HANDOFF "upkeep treadmill") — this runs the
// documented known-good extraction (Fight Club, tmdb 550) on an interval with
// the cache bypassed, keeping a small in-memory result history so the admin
// dashboard shows breakage before a user's movie night hits it.

const INTERVAL_MS = 60 * 60 * 1000;
const HISTORY_MAX = 24;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // let the stack settle after boot
const CANARY_JOB = { type: "movie", tmdb: "550" };

function createCanary({ extractClient, log = console, intervalMs = INTERVAL_MS }) {
  const history = [];
  let timer = null;
  let running = null;

  async function run() {
    if (running) return running; // never overlap canary extractions
    running = (async () => {
      const t0 = Date.now();
      let ok = false;
      let error = null;
      try {
        const r = await extractClient.extract(CANARY_JOB, { fresh: true });
        ok = r.ok;
        error = r.ok ? null : r.error;
      } catch (e) {
        error = e.message;
      }
      const entry = { at: t0, ok, ms: Date.now() - t0, error };
      history.push(entry);
      if (history.length > HISTORY_MAX) history.shift();
      if (!ok && log.warn) log.warn(`extraction canary FAILED: ${error}`);
      running = null;
      return entry;
    })();
    return running;
  }

  // Timers are unref'd so a pending canary never holds the process open.
  function start() {
    if (process.env.STREAMBERT_CANARY === "0" || timer) return;
    timer = setInterval(run, intervalMs);
    if (timer.unref) timer.unref();
    const first = setTimeout(run, FIRST_RUN_DELAY_MS);
    if (first.unref) first.unref();
  }

  return {
    run,
    start,
    status: () => ({
      last: history[history.length - 1] || null,
      passRate: history.length
        ? history.filter((h) => h.ok).length / history.length
        : null,
      history: [...history],
    }),
  };
}

module.exports = { createCanary };
