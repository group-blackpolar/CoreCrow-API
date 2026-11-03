import type { FastifyInstance } from "fastify";
import { documentRoutes } from "./documents.js";
import { aiRoutes } from "./ai.js";
import { securityAccessRoutes } from "./security-access.js";
import { northDataRoutes } from "./v1/north-data.js";
import { northContentRoutes } from "./v1/north-content.js";
import { tenancyRoutes } from "./v1/tenancy.js";
import { accountRoutes } from "./v1/account.js";
import { platformRoutes } from "./v1/platform.js";
import { commerceRoutes } from "./v1/commerce.js";

/** Composes the /v1 area plugins; each area owns its schemas and contracts (RM-022). */
export async function v1Routes(app: FastifyInstance) {
  await app.register(documentRoutes);
  await app.register(aiRoutes);
  await app.register(securityAccessRoutes);
  await app.register(northDataRoutes);
  await app.register(northContentRoutes);
  await app.register(tenancyRoutes);
  await app.register(accountRoutes);
  await app.register(platformRoutes);
  await app.register(commerceRoutes);
}
