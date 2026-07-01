"use strict";
// WebSocket event hub at /api/events. Broadcasts { channel, payload } frames to
// all authenticated clients. Backend code calls fastify.broadcast(channel, payload)
// to push events the Electron app used to send via webContents.send(...).

const clients = new Set();

module.exports = function (fastify) {
  fastify.decorate("broadcast", (channel, payload) => {
    const msg = JSON.stringify({ channel, payload });
    for (const ws of clients) {
      try {
        ws.send(msg);
      } catch {
        /* drop */
      }
    }
  });

  fastify.get("/api/events", { websocket: true }, (conn, req) => {
    // @fastify/websocket v10: conn.socket is the ws. Auth via session cookie.
    if (!fastify.sessionValid(req)) {
      try {
        conn.socket.close();
      } catch {}
      return;
    }
    clients.add(conn.socket);
    conn.socket.on("close", () => clients.delete(conn.socket));
    conn.socket.on("error", () => clients.delete(conn.socket));
  });
};
