import { z } from "zod";
export const id = z.string().min(1).max(128);
export const date = z.string().datetime();
export const name = z.string().trim().min(2).max(100);
export const role = z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
export const globalRole = z.enum(["USER", "DEVELOPER", "ADMIN", "SUPERADMIN"]);
export const orgParams = z.object({ organizationId: id }).strict();
export const memberParams = orgParams.extend({ userId: id });
export const org = z.object({
  id,
  name,
  slug: z.string(),
  createdAt: date,
  updatedAt: date,
});
export const user = z.object({
  id,
  name: z.string().nullable(),
  email: z.string().email(),
  role: globalRole,
  emailVerified: z.boolean(),
  termsAcceptedAt: date.nullable(),
  termsVersion: z.string().nullable(),
  createdAt: date,
});
export const member = z.object({
  id,
  organizationId: id,
  userId: id,
  role,
  createdAt: date,
});
export const plan = z.object({
  id,
  productId: id,
  code: z.string(),
  name,
  priceMinor: z.number().int().nonnegative(),
  currency: z.string(),
  interval: z.string(),
  features: z.array(z.string()),
  active: z.boolean(),
});
export const product = z.object({
  id,
  code: z.string(),
  name,
  active: z.boolean(),
  plans: z.array(plan).optional(),
});
export const invoice = z.object({
  id,
  subscriptionId: id,
  amountMinor: z.number().int(),
  currency: z.string(),
  status: z.string(),
  createdAt: date,
});
export const entitlement = z.object({
  id,
  organizationId: id,
  subscriptionId: id,
  productCode: z.string(),
  feature: z.string(),
  expiresAt: date,
  revokedAt: date.nullable(),
});
export const subscription = z.object({
  id,
  organizationId: id,
  planId: id,
  status: z.string(),
  startsAt: date,
  endsAt: date,
  createdAt: date,
  invoices: z.array(invoice).optional(),
  entitlements: z.array(entitlement).optional(),
});
export const auditEvent = z.object({
  id,
  actorId: id.nullable(),
  organizationId: id.nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: id.nullable(),
  createdAt: date,
});
export const error = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export const health = z.object({
  status: z.enum(["operational", "degraded"]),
  apiVersion: z.literal("v1"),
  uptimeSeconds: z.number().int().nonnegative(),
  checkedAt: date,
  modules: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["available", "unavailable"]),
    }),
  ),
  emailDelivery: z.enum(["configured", "not_configured"]),
  emailTransport: z.enum(["available", "unavailable", "not_configured"]),
  commerceMode: z.literal("contract_provisioning"),
});
export const statusWindow = z.enum(["1h", "6h", "24h"]);
export const statusSummaryQuery = z
  .object({ window: statusWindow.default("24h") })
  .strict();
const statusBucket = z.object({
  startedAt: date,
  requests: z.number().int().nonnegative(),
  averageLatencyMs: z.number().nonnegative().nullable(),
  errors4xx: z.number().int().nonnegative(),
  errors5xx: z.number().int().nonnegative(),
});
export const statusSummary = z.object({
  window: statusWindow,
  bucketSeconds: z.number().int().min(1),
  generatedAt: date,
  observedSince: date,
  coverageSeconds: z.number().int().min(1),
  uptimeSeconds: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  requestsPerSecond: z.number().nonnegative(),
  latencyMs: z.object({
    average: z.number().nonnegative().nullable(),
    p50: z.number().nonnegative().nullable(),
    p95: z.number().nonnegative().nullable(),
  }),
  errors: z.object({
    client: z.number().int().nonnegative(),
    server: z.number().int().nonnegative(),
  }),
  series: z.array(statusBucket),
});
export const contactInput = z
  .object({
    name,
    email: z.string().email().max(254),
    organization: z.string().trim().min(1).max(150),
    country: z.string().min(1).max(100),
    project: z.string().min(1).max(100),
    message: z.string().max(5000),
    locale: z.enum(["es-lat", "en-us"]),
    consent: z.literal(true),
  })
  .strict();
