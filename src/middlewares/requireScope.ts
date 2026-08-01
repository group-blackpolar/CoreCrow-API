// src/middlewares/requireScope.ts
import { FastifyRequest, FastifyReply } from 'fastify';

export function requireScope(scope: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Sesión de admin/superadmin pasa siempre, sin depender de scopes
    if (req.user && ['ADMIN', 'SUPERADMIN'].includes(req.user.role)) {
      return;
    }

    // Si no hay sesión de admin, tiene que venir con un token que traiga el scope exacto
    if (!req.apiKey) {
      return reply.code(401).send({ error: 'No autenticado' });
    }

    if (!req.apiKey.scopes.includes(scope)) {
      return reply.code(403).send({ error: `Falta el permiso: ${scope}` });
    }
  };
}