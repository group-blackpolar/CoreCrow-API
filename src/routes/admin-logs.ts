import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/database.js";
import { authenticateAdmin } from "../middlewares/authenticateAdmin.js";
import { audit } from "../middlewares/audit.js";

/**
 * GET /api/admin/logs
 * Query params:
 *  - limit    (default 50, máx 200)
 *  - cursor   (id del último AuditLog visto, para paginación)
 *  - action   (filtra por acción exacta, ej. "apikey.revoke")
 *  - actorId  (filtra por quién hizo la acción)
 */
export async function adminLogsRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { limit?: string; cursor?: string; action?: string; actorId?: string };
  }>(
    "/admin/logs",
    {
      preHandler: [authenticateAdmin],
      onResponse: audit({ action: "logs.view", targetType: "AuditLog" }),
    },
    async (request, reply) => {
      const { cursor, action, actorId } = request.query;
      const limit = Math.min(Number(request.query.limit) || 50, 200);

      const logs = await prisma.auditLog.findMany({
        where: {
          ...(action ? { action } : {}),
          ...(actorId ? { actorId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      const nextCursor = logs.length === limit ? logs[logs.length - 1]?.id ?? null : null;

      return reply.send({ logs, nextCursor });
    }
  );
}
