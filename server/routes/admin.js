"use strict";
const { createUser, listUsers, resetPassword, deleteUser } = require("../lib/users");

module.exports = async function (fastify) {
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.user || req.user.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
  });

  fastify.get("/api/admin/users", async () => listUsers(fastify.db));

  fastify.post("/api/admin/users", async (req, reply) => {
    const { username, password, role } = req.body || {};
    try {
      return createUser(fastify.db, { username, password, role: role === "admin" ? "admin" : "user" });
    } catch (e) {
      if (e.code === "DUP") return reply.code(409).send({ error: "username taken" });
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.post("/api/admin/users/:id/reset-password", async (req, reply) => {
    try {
      resetPassword(fastify.db, Number(req.params.id), (req.body || {}).password);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.delete("/api/admin/users/:id", async (req, reply) => {
    try {
      deleteUser(fastify.db, Number(req.params.id));
      return { ok: true };
    } catch (e) {
      if (e.code === "LAST_ADMIN") return reply.code(400).send({ error: "cannot delete the last admin" });
      return reply.code(400).send({ error: e.message });
    }
  });
};
