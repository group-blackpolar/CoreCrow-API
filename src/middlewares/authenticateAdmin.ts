// src/middlewares/authenticateAdmin.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { prisma } from '../lib/database.js';

function hashToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

export async function authenticateAdmin(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'No autenticado' });
  }

  const rawToken = authHeader.slice(7);
  const tokenHash = hashToken(rawToken);

  const session = await prisma.session.findUnique({
    where: { token: tokenHash },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    return reply.code(401).send({ error: 'Sesión inválida o expirada' });
  }

  if (session.user.role !== 'ADMIN' && session.user.role !== 'SUPERADMIN') {
    return reply.code(403).send({ error: 'No es una cuenta de administrador' });
  }

  req.admin = { id: session.user.id, role: session.user.role };
  req.user = { id: session.user.id, role: session.user.role }; 
}