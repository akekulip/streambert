"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const WebSocket = require("ws");
const { openDb } = require("../lib/db");
const { insertUser } = require("../lib/users");
const { createLoginThrottle } = require("../lib/loginThrottle");
const { buildApp } = require("../app");

async function cookieFor(app, username, password) {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  return r.cookies.find((c) => c.name === "sb_session").value;
}

function connect(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, {
      headers: { cookie: `sb_session=${cookie}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

test("state-changed reaches the same user's sessions only", async () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  insertUser(db, { username: "bob", password: "bobpass12", role: "user" });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const alice = await cookieFor(app, "alice", "alicepass");
  const bob = await cookieFor(app, "bob", "bobpass12");

  const aliceWs = await connect(port, alice);
  const bobWs = await connect(port, bob);

  const aliceMsgs = [];
  const bobMsgs = [];
  aliceWs.on("message", (d) => aliceMsgs.push(JSON.parse(d.toString())));
  bobWs.on("message", (d) => bobMsgs.push(JSON.parse(d.toString())));

  await app.inject({
    method: "PUT", url: "/api/state/progress/movie_550",
    cookies: { sb_session: alice }, payload: { pct: 50 },
  });
  await new Promise((r) => setTimeout(r, 200));

  const stateMsgs = aliceMsgs.filter((m) => m.channel === "state-changed");
  assert.equal(stateMsgs.length, 1);
  assert.deepEqual(stateMsgs[0].payload, { domain: "progress" });
  assert.equal(bobMsgs.filter((m) => m.channel === "state-changed").length, 0);

  aliceWs.close();
  bobWs.close();
  await app.close();
});

test("unauthenticated WS is closed immediately", async () => {
  const db = openDb(":memory:");
  insertUser(db, { username: "alice", password: "alicepass", role: "user" });
  const app = await buildApp({
    db, cookieSecret: "test-secret", loginThrottle: createLoginThrottle(),
    dataDir: os.tmpdir(), distDir: "/nonexistent",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const closed = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    ws.on("close", () => resolve(true));
    ws.on("error", () => resolve(true));
    setTimeout(() => resolve(false), 1000);
  });
  assert.equal(closed, true);
  await app.close();
});
