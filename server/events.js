"use strict";
// WebSocket event hub at /api/events. Broadcasts { channel, payload } frames.
// fastify.broadcast(...) sends to all authenticated clients;
// fastify.broadcastToUser(userId, ...) sends only to that user's sessions
// (cross-device state sync — Phase 2).

const clients = new Map(); // ws -> userId

module.exports = function (fastify) {
  fastify.decorate("broadcast", (channel, payload) => {
    const msg = JSON.stringify({ channel, payload });
    for (const ws of clients.keys()) {
      try {
        ws.send(msg);
      } catch {
        /* drop */
      }
    }
  });

  fastify.decorate("broadcastToUser", (userId, channel, payload) => {
    const msg = JSON.stringify({ channel, payload });
    for (const [ws, uid] of clients) {
      if (uid !== userId) continue;
      try {
        ws.send(msg);
      } catch {
        /* drop */
      }
    }
  });

  fastify.get("/api/events", { websocket: true }, (conn, req) => {
    // @fastify/websocket v10: conn.socket is the ws. Auth via session cookie.
    const user = fastify.resolveUser(req);
    if (!user) {
      try {
        conn.socket.close();
      } catch {}
      return;
    }
    clients.set(conn.socket, user.id);
    conn.socket.on("close", () => clients.delete(conn.socket));
    conn.socket.on("error", () => clients.delete(conn.socket));
  });
};
