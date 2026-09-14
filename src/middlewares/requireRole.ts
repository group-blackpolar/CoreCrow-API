// src/middlewares/requireRole.ts
import { FastifyRequest, FastifyReply } from "fastify";

const ROLE_ORDER = ["USER", "DEVELOPER", "ADMIN", "SUPERADMIN"];

export function requireRole(minRole: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.code(401).send({ error: "No autenticado" });
    }

    const userLevel = ROLE_ORDER.indexOf(req.user.role);
    const requiredLevel = ROLE_ORDER.indexOf(minRole);

    if (userLevel === -1 || userLevel < requiredLevel) {
      return reply.code(403).send({ error: "No tienes permisos suficientes" });
    }
  };
}
