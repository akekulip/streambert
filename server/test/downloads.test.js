"use strict";
// ── /api/downloads authorization + concurrency-cap tests (I1) ─────────────────
// Two regressions closed here:
//   1. The registry was global — any active user could see/delete ALL users'
//      downloads. Now every record carries a `userId` set at creation time,
//      and every read/mutation is scoped to req.user (admins see/manage all).
//      Legacy records with no userId (pre-fix registry rows) are hidden from
//      regular users and visible only to admins.
//   2. POST / could spawn unbounded downloader (vid-dl) processes. Now capped
//      at MAX_CONCURRENT_DOWNLOADS in flight; the next spawn attempt gets 429.
//
// A real `vid-dl` binary is never assumed to be installed. Tests either drive
// the manager directly (no process spawn at all — the legacy-record and
// ownsDownload cases), or point STREAMBERT_DOWNLOADER at a tiny stub shell
// script that ignores all argv and sleeps for a fixed, short duration — this
// keeps a spawned process "in flight" long enough to observe the cap
// deterministically, without depending on any download-specific tooling.
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");
const {
  createDownloadManager,
  MAX_CONCURRENT_DOWNLOADS,
  ownsDownload,
} = require("../lib/downloads");

function makeStubDownloader(dir, seconds) {
  const p = path.join(dir, `stub-dl-${crypto.randomUUID()}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\nsleep ${seconds}\n`, { mode: 0o755 });
  return p;
}

function tmpDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function makeApp(dataDir) {
  const db = openDb(":memory:");
  insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  insertUser(db, { username: "alice", password: "alicepass1", role: "user" });
  insertUser(db, { username: "bob", password: "bobpass1", role: "user" });
  const app = await buildApp({
    db,
    cookieSecret: "test-secret",
    loginThrottle: createLoginThrottle(),
    dataDir,
    distDir: "/nonexistent",
  });
  return { app, db };
}

async function cookieFor(app, username, password) {
  const r = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username, password },
  });
  return r.cookies.find((c) => c.name === "sb_session").value;
}

// ── Pure unit tests: ownership + legacy migration (no spawn, no HTTP) ────────

test("ownsDownload: user only owns their own records; admin owns everything; legacy (no userId) records belong to nobody but admin", () => {
  assert.equal(ownsDownload({ userId: 5 }, { id: 5, role: "user" }), true);
  assert.equal(ownsDownload({ userId: 5 }, { id: 6, role: "user" }), false);
  assert.equal(ownsDownload({ userId: 5 }, { id: 6, role: "admin" }), true);
  assert.equal(ownsDownload({ userId: null }, { id: 5, role: "user" }), false);
  assert.equal(ownsDownload({}, { id: 5, role: "user" }), false); // legacy: no userId field at all
  assert.equal(ownsDownload({ userId: null }, { id: 1, role: "admin" }), true);
});

test("legacy download records (no userId, pre-dating this fix) are hidden from regular users but visible to admin", () => {
  const dataDir = tmpDataDir("sb-dl-legacy-");
  fs.writeFileSync(
    path.join(dataDir, "downloads.json"),
    JSON.stringify([
      { id: "legacy-1", name: "Old Movie", status: "completed", startedAt: Date.now() },
    ]),
  );
  const manager = createDownloadManager({
    dataDir,
    downloaderPath: "vid-dl",
    broadcast: () => {},
  });
  assert.equal(manager.getDownloads({ id: 5, role: "user" }).length, 0);
  const forAdmin = manager.getDownloads({ id: 1, role: "admin" });
  assert.equal(forAdmin.length, 1);
  assert.equal(forAdmin[0].id, "legacy-1");
});

test("direct manager unit test: runDownload rejects with TOO_MANY once activeProcs is at MAX_CONCURRENT_DOWNLOADS", () => {
  const dataDir = tmpDataDir("sb-dl-unit-");
  const stub = makeStubDownloader(dataDir, 2);
  const manager = createDownloadManager({
    dataDir,
    downloaderPath: stub,
    broadcast: () => {},
  });
  const user = { id: 1, role: "user" };
  for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) {
    const r = manager.runDownload(
      { m3u8Url: `https://example.com/${i}.m3u8`, name: `S${i}` },
      user,
    );
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.equal(manager.getActiveDownloadCount(), MAX_CONCURRENT_DOWNLOADS);
  const rejected = manager.runDownload(
    { m3u8Url: "https://example.com/x.m3u8", name: "X" },
    user,
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "TOO_MANY");
});

// ── HTTP-level tests (app.inject) ────────────────────────────────────────────

test("GET /api/downloads scopes to the caller; POST /delete on another user's download is forbidden and does not delete it", async () => {
  const dataDir = tmpDataDir("sb-dl-scope-");
  const prevDownloader = process.env.STREAMBERT_DOWNLOADER;
  process.env.STREAMBERT_DOWNLOADER = makeStubDownloader(dataDir, 2);
  try {
    const { app } = await makeApp(dataDir);
    const aliceCookie = await cookieFor(app, "alice", "alicepass1");
    const bobCookie = await cookieFor(app, "bob", "bobpass1");

    const startA = await app.inject({
      method: "POST",
      url: "/api/downloads",
      cookies: { sb_session: aliceCookie },
      payload: { m3u8Url: "https://example.com/a.m3u8", name: "AliceShow" },
    });
    assert.equal(startA.statusCode, 200);
    assert.equal(startA.json().ok, true);
    const aliceId = startA.json().id;

    const startB = await app.inject({
      method: "POST",
      url: "/api/downloads",
      cookies: { sb_session: bobCookie },
      payload: { m3u8Url: "https://example.com/b.m3u8", name: "BobShow" },
    });
    assert.equal(startB.statusCode, 200);
    assert.equal(startB.json().ok, true);
    const bobId = startB.json().id;

    // Alice's list includes her own download, not Bob's.
    const aliceList = await app.inject({
      method: "GET",
      url: "/api/downloads",
      cookies: { sb_session: aliceCookie },
    });
    assert.equal(aliceList.statusCode, 200);
    const aliceIds = aliceList.json().map((d) => d.id);
    assert.ok(aliceIds.includes(aliceId));
    assert.ok(!aliceIds.includes(bobId));

    // Alice cannot delete Bob's download.
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/downloads/delete",
      cookies: { sb_session: aliceCookie },
      payload: { id: bobId },
    });
    assert.equal(forbidden.statusCode, 403);

    // Bob's download is still in the registry (from Bob's own view).
    const bobList = await app.inject({
      method: "GET",
      url: "/api/downloads",
      cookies: { sb_session: bobCookie },
    });
    assert.ok(bobList.json().some((d) => d.id === bobId));
    assert.ok(!bobList.json().some((d) => d.id === aliceId));

    // Alice CAN delete her own download.
    const ownDelete = await app.inject({
      method: "POST",
      url: "/api/downloads/delete",
      cookies: { sb_session: aliceCookie },
      payload: { id: aliceId },
    });
    assert.equal(ownDelete.statusCode, 200);
    assert.equal(ownDelete.json().ok, true);

    await app.close();
  } finally {
    if (prevDownloader === undefined) delete process.env.STREAMBERT_DOWNLOADER;
    else process.env.STREAMBERT_DOWNLOADER = prevDownloader;
  }
});

test("POST /api/downloads/delete-all only wipes the caller's own downloads", async () => {
  const dataDir = tmpDataDir("sb-dl-deleteall-");
  const prevDownloader = process.env.STREAMBERT_DOWNLOADER;
  process.env.STREAMBERT_DOWNLOADER = makeStubDownloader(dataDir, 2);
  try {
    const { app } = await makeApp(dataDir);
    const aliceCookie = await cookieFor(app, "alice", "alicepass1");
    const bobCookie = await cookieFor(app, "bob", "bobpass1");

    const startA = await app.inject({
      method: "POST",
      url: "/api/downloads",
      cookies: { sb_session: aliceCookie },
      payload: { m3u8Url: "https://example.com/a.m3u8", name: "AliceShow" },
    });
    const bobStart = await app.inject({
      method: "POST",
      url: "/api/downloads",
      cookies: { sb_session: bobCookie },
      payload: { m3u8Url: "https://example.com/b.m3u8", name: "BobShow" },
    });
    assert.equal(startA.json().ok, true);
    assert.equal(bobStart.json().ok, true);
    const bobId = bobStart.json().id;

    const wipe = await app.inject({
      method: "POST",
      url: "/api/downloads/delete-all",
      cookies: { sb_session: aliceCookie },
    });
    assert.equal(wipe.statusCode, 200);
    assert.equal(wipe.json().ok, true);

    // Alice sees nothing left; Bob's download survives.
    const aliceList = await app.inject({
      method: "GET",
      url: "/api/downloads",
      cookies: { sb_session: aliceCookie },
    });
    assert.equal(aliceList.json().length, 0);
    const bobList = await app.inject({
      method: "GET",
      url: "/api/downloads",
      cookies: { sb_session: bobCookie },
    });
    assert.ok(bobList.json().some((d) => d.id === bobId));

    await app.close();
  } finally {
    if (prevDownloader === undefined) delete process.env.STREAMBERT_DOWNLOADER;
    else process.env.STREAMBERT_DOWNLOADER = prevDownloader;
  }
});

// Seeds a fresh users db (admin/alice/bob) + a downloads.json registry file
// *before* buildApp constructs the download manager (which loads the
// registry from disk exactly once, at creation time) — this is how these
// tests get real, known registry rows (with real subtitlePaths/filePath
// values) into the running app without reaching into the manager instance
// directly (it's a fastify-encapsulated decorator, not reachable from the
// top-level `app` returned by buildApp).
async function makeAppWithSeededRegistry(dataDir, downloadRows) {
  const db = openDb(":memory:");
  const admin = insertUser(db, { username: "admin", password: "adminpass", role: "admin" });
  const alice = insertUser(db, { username: "alice", password: "alicepass1", role: "user" });
  const bob = insertUser(db, { username: "bob", password: "bobpass1", role: "user" });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "downloads.json"),
    JSON.stringify(downloadRows({ admin, alice, bob })),
  );
  const app = await buildApp({
    db,
    cookieSecret: "test-secret",
    loginThrottle: createLoginThrottle(),
    dataDir,
    distDir: "/nonexistent",
  });
  return { app, admin, alice, bob };
}

test("POST /api/downloads/prune-subs on another user's download is forbidden, leaks no subtitle paths, and does not mutate the record", async () => {
  const dataDir = tmpDataDir("sb-dl-prune-");
  const bobSubPath = path.join(dataDir, "secret-bob.srt");
  const { app, bob } = await makeAppWithSeededRegistry(dataDir, ({ bob }) => [
    {
      id: "bob-dl-1",
      userId: bob.id,
      name: "BobShow",
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      subtitlePaths: [{ lang: "en", path: bobSubPath, file_id: null }],
    },
  ]);
  const aliceCookie = await cookieFor(app, "alice", "alicepass1");
  const bobCookie = await cookieFor(app, "bob", "bobpass1");

  // Alice tries to prune Bob's download's subtitle paths.
  const pruneAttempt = await app.inject({
    method: "POST",
    url: "/api/downloads/prune-subs",
    cookies: { sb_session: aliceCookie },
    payload: { downloadId: "bob-dl-1" },
  });
  assert.equal(pruneAttempt.statusCode, 403);
  const body = pruneAttempt.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "FORBIDDEN");
  assert.equal(JSON.stringify(body).includes("secret-bob.srt"), false);

  // Bob's record is unchanged — his subtitlePaths entry is still present
  // (verified via Bob's own scoped read of the registry).
  const bobAfter = (
    await app.inject({
      method: "GET",
      url: "/api/downloads",
      cookies: { sb_session: bobCookie },
    })
  )
    .json()
    .find((d) => d.id === "bob-dl-1");
  assert.ok(bobAfter);
  assert.equal(bobAfter.subtitlePaths.length, 1);
  assert.equal(bobAfter.subtitlePaths[0].path, bobSubPath);

  await app.close();
});

test("GET /api/downloads/size reflects only the caller's own downloads", async () => {
  const dataDir = tmpDataDir("sb-dl-size-");
  const aliceFile = path.join(dataDir, "alice-video.mp4");
  const bobFile = path.join(dataDir, "bob-video.mp4");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(aliceFile, Buffer.alloc(1000, "a"));
  fs.writeFileSync(bobFile, Buffer.alloc(5000, "b"));

  const { app } = await makeAppWithSeededRegistry(dataDir, ({ alice, bob }) => [
    {
      id: "alice-dl-1",
      userId: alice.id,
      name: "AliceShow",
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      filePath: aliceFile,
    },
    {
      id: "bob-dl-1",
      userId: bob.id,
      name: "BobShow",
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      filePath: bobFile,
    },
  ]);
  const aliceCookie = await cookieFor(app, "alice", "alicepass1");
  const bobCookie = await cookieFor(app, "bob", "bobpass1");

  const aliceSize = await app.inject({
    method: "GET",
    url: "/api/downloads/size",
    cookies: { sb_session: aliceCookie },
  });
  assert.equal(aliceSize.statusCode, 200);
  assert.equal(aliceSize.json().bytes, 1000);

  const bobSize = await app.inject({
    method: "GET",
    url: "/api/downloads/size",
    cookies: { sb_session: bobCookie },
  });
  assert.equal(bobSize.json().bytes, 5000);
  assert.notEqual(bobSize.json().bytes, aliceSize.json().bytes);

  await app.close();
});

test("POST /api/downloads returns 429 once MAX_CONCURRENT_DOWNLOADS spawns are already in flight", async () => {
  const dataDir = tmpDataDir("sb-dl-cap-");
  const prevDownloader = process.env.STREAMBERT_DOWNLOADER;
  process.env.STREAMBERT_DOWNLOADER = makeStubDownloader(dataDir, 2);
  try {
    const { app } = await makeApp(dataDir);
    const cookie = await cookieFor(app, "alice", "alicepass1");

    const results = [];
    for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS + 1; i++) {
      results.push(
        await app.inject({
          method: "POST",
          url: "/api/downloads",
          cookies: { sb_session: cookie },
          payload: { m3u8Url: `https://example.com/${i}.m3u8`, name: `Show${i}` },
        }),
      );
    }
    for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) {
      assert.equal(results[i].statusCode, 200, `download ${i} should start`);
      assert.equal(results[i].json().ok, true);
    }
    const last = results[MAX_CONCURRENT_DOWNLOADS];
    assert.equal(last.statusCode, 429);
    assert.equal(last.json().error, "too many downloads in progress");

    await app.close();
  } finally {
    if (prevDownloader === undefined) delete process.env.STREAMBERT_DOWNLOADER;
    else process.env.STREAMBERT_DOWNLOADER = prevDownloader;
  }
});
