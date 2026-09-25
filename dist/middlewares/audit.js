import { prisma } from "../lib/database.js";
export function audit(options) {
    return async (req, reply) => {
        // onResponse corre después del handler; solo auditamos 2xx
        if (reply.statusCode < 200 || reply.statusCode >= 300)
            return;
        const actorId = req.admin?.id ?? req.user?.id ?? null;
        const targetId = options.getTargetId?.(req);
        await prisma.auditLog
            .create({
            data: {
                actorId,
                action: options.action,
                targetType: options.targetType,
                targetId,
                requestId: req.id,
                metadata: {
                    apiKeyId: req.apiKey?.id ?? null,
                    ip: req.ip,
                },
            },
        })
            .catch((err) => {
            // un fallo de auditoría nunca debe tumbar la respuesta ya enviada
            req.log.error({ err }, "No se pudo escribir en AuditLog");
        });
    };
}
