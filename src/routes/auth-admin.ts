import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fail } from "../shared/errors.js";
import { createAdminSession, legacyEnabled, legacyLogin, migrateLegacyIdentity, validateAdminUniqueId } from "../modules/identity/legacy-service.js";
import { authenticateAdmin } from "../middlewares/authenticateAdmin.js";
// Removed authentication mechanism: identifiers are not account credentials.
export async function adminSignInRoutes(app: FastifyInstance) {
  const input = z.object({ email: z.string().email().max(254), adminUniqueId: z.string().min(8).max(256) }).strict();
  app.post("/v1/admin/sign-in", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { body: zodToJsonSchema(input, { target: "openApi3" }) } }, async req => {
    const data = input.parse(req.body);
    const user = await validateAdminUniqueId(data.email, data.adminUniqueId);
    if (!user) fail(401, "UNAUTHENTICATED", "Invalid credentials");
    const session = await createAdminSession(user.id, req.ip);
    return { token: session.token };
  });
}

export async function authAdminRoutes(app: FastifyInstance) {
  if (legacyEnabled()) {
    const input = z.object({ email: z.string().email().max(254), adminUniqueId: z.string().min(8).max(256) }).strict();
    app.post("/admin/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { body: zodToJsonSchema(input, { target: "openApi3" }) } }, async req => { const data = input.parse(req.body); return legacyLogin(data.email, data.adminUniqueId, req.ip); });
  }
  for (const path of [
    ...(legacyEnabled() ? [] : ["/admin/login"]),
    "/admin/init",
    "/admin/exists",
    "/admin/users",
  ]) {
    app.all(path, async (req, reply) =>
      reply
        .code(410)
        .send({
          error: {
            code: "LEGACY_AUTH_DISABLED",
            message:
              "Use Better Auth at /v1/auth. Operator roles are provisioned through the CLI.",
            requestId: req.id,
          },
        }),
    );
  }
}

export async function legacyMigrationRoute(app: FastifyInstance) {
  const input = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(128) }).strict();
  app.post("/v1/identity/legacy-migration", { preHandler: authenticateAdmin, config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { tags: ["Identity"], summary: "Opt-in legacy credential enrollment; revokes old sessions and permanently retires the legacy ID", body: zodToJsonSchema(input, { target: "openApi3" }), response: { 200: { type: "object", required: ["migrated"], properties: { migrated: { const: true } } } } } }, async req => { const data = input.parse(req.body); return migrateLegacyIdentity(req.user!.id, data.email, data.password); });
}
