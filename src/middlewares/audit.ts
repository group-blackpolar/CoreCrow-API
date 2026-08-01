// src/middlewares/audit.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/database.js';

interface AuditOptions {
  action: string;
  targetType?: string;
  getTargetId?: (req: FastifyRequest) => string | undefined;
}

export function audit(options: AuditOptions) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // onResponse corre después del handler; solo auditamos 2xx
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;

    const actorId = req.admin?.id ?? req.user?.id ?? null;
    const targetId = options.getTargetId?.(req);

    await prisma.auditLog.create({
      data: {
        actorId,
        action: options.action,
        targetType: options.targetType,
        targetId,
        metadata: {
          apiKeyId: req.apiKey?.id ?? null,
          ip: req.ip,
        },
      },
    }).catch((err: unknown) => {
      // un fallo de auditoría nunca debe tumbar la respuesta ya enviada
      req.log.error({ err }, 'No se pudo escribir en AuditLog');
    });
  };
}