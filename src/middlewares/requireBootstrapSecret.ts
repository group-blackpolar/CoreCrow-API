// src/middlewares/requireBootstrapSecret.ts
import { FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";

export async function requireBootstrapSecret(req: FastifyRequest, reply: FastifyReply) {
  const provided = req.headers["x-bootstrap-secret"];
  const expected = process.env.ADMIN_BOOTSTRAP_SECRET;

  if (!expected) return reply.code(500).send({ error: "ADMIN_BOOTSTRAP_SECRET no configurado" });
  if (typeof provided !== "string" || provided.length !== expected.length) {
    return reply.code(401).send({ error: "Secreto inválido" });
  }
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return reply.code(401).send({ error: "Secreto inválido" });
  }
}