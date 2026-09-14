import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateAdmin } from "../middlewares/authenticateAdmin.js";
import { security, keyScopes } from "../modules/security/service.js";
export async function adminKeysRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticateAdmin);
  app.get("/admin/keys", async (req) => security.list(req.user!.id));
  app.post("/admin/keys", async (req, reply) => {
    const input = z
      .object({
        name: z.string().min(2).max(100),
        scopes: z.array(z.enum(keyScopes)).min(1).max(2),
      })
      .strict()
      .parse(req.body);
    return reply.code(201).send(await security.create(req.user!.id, input));
  });
  app.delete<{ Params: { id: string } }>("/admin/keys/:id", async (req) =>
    security.revoke(req.user!.id, req.params.id),
  );
}
