import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { prisma } from "../lib/database.js";
import { authenticateAdmin } from "../middlewares/authenticateAdmin.js";
import { audit } from "../middlewares/audit.js";
import { createApiKeySchema } from "../lib/validators.js";

const KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días fijos

function hashToken(raw: string) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Rutas de administración de API Keys (consumidas por North)
 * - POST   /api/admin/keys       crear una key nueva (el token en claro solo se muestra una vez)
 * - GET    /api/admin/keys       listar keys (sin exponer el hash)
 * - DELETE /api/admin/keys/:id   revocar una key
 */
export async function adminKeysRoutes(app: FastifyInstance) {
  app.post(
    "/admin/keys",
    {
      preHandler: [authenticateAdmin],
      onResponse: audit({ action: "apikey.create", targetType: "ApiKey" }),
    },
    async (request, reply) => {
      const parsed = createApiKeySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { name, scopes } = parsed.data;

      // Token en claro: 32 bytes random en hex, con prefijo legible tipo "bp_"
      const rawToken = `bp_${crypto.randomBytes(32).toString("hex")}`;
      const keyHash = hashToken(rawToken);
      const prefix = rawToken.slice(0, 10); // ej. "bp_3f9a2c1"

      const apiKey = await prisma.apiKey.create({
        data: {
          userId: request.admin!.id,
          name,
          keyHash,
          prefix,
          scopes,
          expiresAt: new Date(Date.now() + KEY_TTL_MS),
        },
      });

      // El token en claro se devuelve UNA sola vez — no se puede recuperar después
      return reply.status(201).send({
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        scopes: apiKey.scopes,
        expiresAt: apiKey.expiresAt,
        token: rawToken,
      });
    }
  );

  app.get("/admin/keys", { preHandler: [authenticateAdmin] }, async () => {
    return prisma.apiKey.findMany({
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        lastUsed: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        userId: true,
      },
      orderBy: { createdAt: "desc" },
    });
  });

  app.delete<{ Params: { id: string } }>(
    "/admin/keys/:id",
    {
      preHandler: [authenticateAdmin],
      onResponse: audit({
        action: "apikey.revoke",
        targetType: "ApiKey",
        getTargetId: (req) => (req.params as { id: string }).id,
      }),
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await prisma.apiKey.findUnique({ where: { id } });
      if (!existing) {
        return reply.status(404).send({ error: "API key no encontrada" });
      }
      if (existing.revokedAt) {
        return reply.status(400).send({ error: "La key ya está revocada" });
      }

      const revoked = await prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      });

      return reply.send({
        success: true,
        id: revoked.id,
        revokedAt: revoked.revokedAt,
      });
    }
  );
}
