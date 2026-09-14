import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateAdmin } from "../middlewares/authenticateAdmin.js";
import { operatorLogs } from "../modules/audit/service.js";
export async function adminLogsRoutes(app: FastifyInstance) {
  app.get("/admin/logs", { preHandler: authenticateAdmin }, async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(128).optional(),
        action: z.string().max(100).optional(),
        actorId: z.string().max(128).optional(),
      })
      .strict()
      .parse(req.query);
    return operatorLogs(req.user!.id, query);
  });
}
