import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../../contracts/route.js";
import * as s from "../../contracts/schemas.js";
import { billing } from "../../modules/billing/service.js";
import { commerce } from "../../modules/commerce/service.js";
import { fail } from "../../shared/errors.js";
import { billingStatus, billingView } from "./shared.js";

export async function commerceRoutes(app: FastifyInstance) {
  contract(app, {
    method: "GET",
    url: "/platform/billing/summary",
    tag: "Billing",
    summary: "Read provider-neutral organization billing aggregates (operator only)",
    response: z.object({
      currency: z.literal("USD"),
      basePriceMinor: z.literal(1400),
      memberPriceMinor: z.literal(500),
      groupsCostMinor: z.literal(0),
      organizationCount: z.number().int().nonnegative(),
      billableMemberCount: z.number().int().nonnegative(),
      estimatedMonthlyMinor: z.number().int().nonnegative(),
      byStatusScope: z.literal("ALL_PROFILES"),
      byStatus: z.array(
        z.object({ status: billingStatus, count: z.number().int().nonnegative() }),
      ),
    }),
    run: ({ user }) => billing.summary(user.id),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/billing",
    tag: "Billing",
    summary: "Read the deterministic organization billing estimate",
    params: s.orgParams,
    response: billingView,
    run: ({ user, params }) => billing.read(user.id, params.organizationId),
  });
  contract(app, {
    method: "PATCH",
    url: "/organizations/:organizationId/billing",
    tag: "Billing",
    summary: "Update organization billing contact information",
    params: s.orgParams,
    body: z
      .object({ billingEmail: z.string().trim().email().max(254).nullable() })
      .strict(),
    response: billingView,
    run: ({ user, params, body }) =>
      billing.updateEmail(user.id, params.organizationId, body.billingEmail),
  });
  contract(app, {
    method: "GET",
    url: "/commerce/products",
    tag: "Commerce",
    summary: "Read the public active product and plan catalog",
    public: true,
    response: z.array(s.product),
    run: () => commerce.catalog(),
  });
  contract(app, {
    method: "POST",
    url: "/commerce/products",
    tag: "Commerce",
    summary: "Create a commercial product (superadmin)",
    body: z
      .object({ code: z.string().regex(/^[a-z0-9-]{2,60}$/), name: s.name })
      .strict(),
    response: s.product,
    status: 201,
    run: ({ user, body }) => commerce.product(user.id, body),
  });
  contract(app, {
    method: "POST",
    url: "/commerce/plans",
    tag: "Commerce",
    summary: "Create a plan with exact minor-unit pricing (superadmin)",
    body: z
      .object({
        productId: s.id,
        code: z.string().regex(/^[a-z0-9-]{2,60}$/),
        name: s.name,
        priceMinor: z.number().int().min(0).max(2147483647),
        currency: z.string().regex(/^[A-Z]{3}$/),
        interval: z.enum(["month", "year", "contract"]),
        features: z
          .array(z.string().regex(/^[a-z][a-z0-9.:_-]{1,100}$/))
          .min(1)
          .max(100),
      })
      .strict(),
    response: s.plan,
    status: 201,
    run: ({ user, body }) => commerce.plan(user.id, body),
  });
  contract(app, {
    method: "POST",
    url: "/commerce/subscriptions",
    idempotency: true,
    tag: "Commerce",
    summary:
      "Provision an approved contract; requires Idempotency-Key and superadmin; no payment collected",
    body: z
      .object({ organizationId: s.id, planId: s.id, endsAt: s.date })
      .strict(),
    response: s.subscription,
    status: 201,
    run: ({ user, body, request }) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[\w-]{16,128}$/.test(key))
        fail(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Provide a 16–128 character Idempotency-Key",
        );
      return commerce.provision(user.id, body, key);
    },
  });
  contract(app, {
    method: "POST",
    url: "/commerce/organizations/:organizationId/subscriptions/:id/cancel",
    tag: "Commerce",
    summary:
      "Cancel a contract and revoke entitlements atomically (superadmin)",
    params: s.orgParams.extend({ id: s.id }),
    response: s.subscription,
    run: ({ user, params }) =>
      commerce.cancel(user.id, params.organizationId, params.id),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/subscriptions",
    tag: "Commerce",
    summary: "Read tenant subscriptions and invoices",
    params: s.orgParams,
    response: z.array(s.subscription),
    run: ({ user, params }) => commerce.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/entitlements",
    tag: "Commerce",
    summary: "Resolve active and unexpired tenant entitlements",
    params: s.orgParams,
    response: z.array(s.entitlement),
    run: ({ user, params }) =>
      commerce.entitlements(user.id, params.organizationId),
  });
}
