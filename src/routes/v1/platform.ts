import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../../contracts/route.js";
import * as s from "../../contracts/schemas.js";
import { platform } from "../../modules/platform/service.js";
import { billing } from "../../modules/billing/service.js";
import { users } from "../../modules/identity/service.js";
import { INSPECTION_SESSION_HEADER } from "../../modules/authorization/inspection.js";
import { northGlobalCapabilities } from "../../modules/authorization/policy.js";
import { operatorLogs } from "../../modules/audit/service.js";
import { auidState, regenerateAuid, revealAuid } from "../../modules/identity/admin-secret-service.js";
import { northPlatformPermissions } from "../../modules/north/service.js";
import { billingStatus, rawBillingProfile, billingView } from "./shared.js";

export async function platformRoutes(app: FastifyInstance) {
  const pageQuery = z
    .object({
      q: z.string().trim().min(1).max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: s.id.optional(),
    })
    .strict();
  const platformMembership = z.object({
    id: s.id,
    role: s.role,
    createdAt: s.date,
    organization: z.object({
      id: s.id,
      name: s.name,
      slug: z.string(),
      status: s.organizationStatus,
    }),
  });
  const platformOrganizationSummary = s.org.extend({
    // Oldest OWNER membership, or null when the organization has no owner yet.
    owner: z
      .object({
        id: s.id,
        name: z.string().nullable(),
        email: z.string().email(),
      })
      .nullable(),
    memberCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    billingStatus: z.enum(["ACTIVE", "PAST_DUE", "SUSPENDED", "CLOSED"]).nullable(),
    billingCurrency: z.string().nullable(),
  });
  contract(app, {
    method: "GET",
    url: "/platform/users",
    tag: "Platform administration",
    summary: "Search and page non-secret identity summaries (operator only); accounts created by organizations are listed only with organizationManaged=true",
    query: pageQuery.extend({ organizationManaged: z.enum(["true", "false"]).default("false").transform((value) => value === "true") }),
    response: z.object({
      items: z.array(s.user.extend({ organizationCount: z.number().int().nonnegative() })),
      nextCursor: s.id.nullable(),
    }),
    run: ({ user, query }) => platform.users(user.id, query),
  });
  contract(app, {
    method: "GET",
    url: "/platform/users/:id",
    tag: "Platform administration",
    summary: "Read identity and membership detail (operator only)",
    params: z.object({ id: s.id }).strict(),
    response: s.user.extend({ memberships: z.array(platformMembership) }),
    run: ({ user, params }) => platform.user(user.id, params.id),
  });
  contract(app, {
    method: "POST",
    url: "/platform/users/preprovision",
    tag: "Platform administration",
    summary: "Pre-provision an identity and email its temporary credential",
    body: z
      .object({
        name: s.name,
        email: z.string().trim().email().max(254),
        role: z.enum(["USER", "DEVELOPER", "ADMIN"]).default("USER"),
      })
      .strict(),
    response: z.object({ user: s.user, delivery: z.enum(["sent", "failed"]) }),
    status: 201,
    run: ({ user, body }) => users.preprovision(user.id, body),
  });
  contract(app, {
    method: "POST",
    url: "/platform/users",
    tag: "Platform administration",
    summary:
      "Create an account with an assigned login (email-shaped) and password, already verified (superadmin)",
    body: z
      .object({
        name: s.name,
        email: z.string().trim().email().max(254),
        password: z.string().min(12).max(128),
        role: z.enum(["USER", "DEVELOPER", "ADMIN"]).default("ADMIN"),
        passwordChangeRequired: z.boolean().default(true),
      })
      .strict(),
    response: s.user,
    status: 201,
    rateLimit: 20,
    run: ({ user, body }) => users.createAssigned(user.id, body),
  });
  contract(app, {
    method: "POST",
    url: "/platform/users/:id/verify-email",
    tag: "Platform administration",
    summary: "Mark an account as verified without its emailed code (superadmin, idempotent)",
    params: z.object({ id: s.id }).strict(),
    response: s.user,
    rateLimit: 60,
    run: ({ user, params }) => users.verifyEmailByOperator(user.id, params.id),
  });
  contract(app, {
    method: "PATCH",
    url: "/platform/users/:id/status",
    tag: "Platform administration",
    summary: "Suspend or restore an identity and revoke all sessions (superadmin)",
    params: z.object({ id: s.id }).strict(),
    body: z.object({ status: s.accountStatus, reason: z.string().trim().min(1).max(500).optional() }).strict(),
    response: s.user,
    run: ({ user, params, body }) =>
      platform.setUserStatus(user.id, params.id, body.status, body.reason),
  });
  contract(app, {
    method: "GET",
    url: "/platform/organizations",
    tag: "Platform administration",
    summary: "Search and page organization summaries (operator only)",
    query: pageQuery,
    response: z.object({
      items: z.array(platformOrganizationSummary),
      nextCursor: s.id.nullable(),
    }),
    run: ({ user, query }) => platform.organizations(user.id, query),
  });
  const platformGroup = s.organizationGroup.extend({
    memberCount: z.number().int().nonnegative(),
    permissionCount: z.number().int().nonnegative(),
  });
  const inspectionView = z.object({ id: s.id, name: z.string(), slug: z.string(), status: s.organizationStatus, iconData: z.string().nullable(), inspectionSessionId: z.string() });
  contract(app, {
    method: "POST",
    url: "/platform/organizations/:id/inspection",
    tag: "Platform administration",
    summary: "Audit the start of a read-only organization inspection (no membership is created)",
    params: z.object({ id: s.id }).strict(),
    response: inspectionView,
    run: ({ user, params, request }) => platform.inspect(user.id, params.id, "start", request.ip),
  });
  contract(app, {
    method: "DELETE",
    url: "/platform/organizations/:id/inspection",
    tag: "Platform administration",
    summary: "Audit the end of a read-only organization inspection",
    params: z.object({ id: s.id }).strict(),
    response: inspectionView,
    run: ({ user, params, request }) => platform.inspect(user.id, params.id, "end", request.ip, request.headers[INSPECTION_SESSION_HEADER]),
  });
  contract(app, {
    method: "GET",
    url: "/platform/users/:id/auid",
    tag: "Platform administration",
    summary: "Whether an administrator has an AUID configured (never returns the credential)",
    params: z.object({ id: s.id }).strict(),
    response: z.object({ configured: z.boolean(), revealable: z.boolean(), encryptionAvailable: z.boolean(), role: s.globalRole }),
    run: ({ user, params }) => auidState(user.id, params.id),
  });
  contract(app, {
    method: "POST",
    url: "/platform/users/:id/auid/reveal",
    tag: "Platform administration",
    summary: "Reveal a recoverable AUID after SUPERADMIN password re-authentication (never cached)",
    params: z.object({ id: s.id }).strict(),
    body: z.object({ password: z.string().min(1).max(256) }).strict(),
    response: z.object({ auid: z.string() }),
    status: 200,
    rateLimit: 30,
    run: ({ user, params, body, request, reply }) => {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      return revealAuid(user.id, params.id, body.password, request.ip);
    },
  });
  contract(app, {
    method: "POST",
    url: "/platform/users/:id/auid/regenerate",
    tag: "Platform administration",
    summary: "Replace an administrator AUID after SUPERADMIN password re-authentication; shown once",
    params: z.object({ id: s.id }).strict(),
    body: z.object({ password: z.string().min(1).max(256) }).strict(),
    response: z.object({ auid: z.string() }),
    rateLimit: 30,
    run: ({ user, params, body, request, reply }) => {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      return regenerateAuid(user.id, params.id, body.password, request.ip);
    },
  });
  contract(app, {
    method: "GET",
    url: "/platform/organizations/:id",
    tag: "Platform administration",
    summary: "Read organization administration detail without tenant bypass",
    params: z.object({ id: s.id }).strict(),
    response: s.org.extend({
      memberships: z.array(
        z.object({
          id: s.id,
          role: s.role,
          createdAt: s.date,
          user: s.user,
        }),
      ),
      groups: z.array(platformGroup),
      billingProfile: rawBillingProfile.nullable(),
      invitationCount: z.number().int().nonnegative(),
    }),
    run: ({ user, params }) => platform.organization(user.id, params.id),
  });
  contract(app, {
    method: "PATCH",
    url: "/platform/organizations/:id/status",
    tag: "Platform administration",
    summary: "Suspend or restore an organization (superadmin)",
    params: z.object({ id: s.id }).strict(),
    body: z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }).strict(),
    response: s.org,
    run: ({ user, params, body }) =>
      platform.setOrganizationStatus(user.id, params.id, body.status),
  });
  contract(app, {
    method: "GET",
    url: "/platform/organizations/:id/billing",
    tag: "Billing",
    summary: "Read billing estimate including zeroed inactive or closed profiles",
    params: z.object({ id: s.id }).strict(),
    response: billingView,
    run: ({ user, params }) => billing.platformRead(user.id, params.id),
  });
  contract(app, {
    method: "PATCH",
    url: "/platform/organizations/:id/billing/status",
    tag: "Billing",
    summary: "Update organization billing status without charging (superadmin)",
    params: z.object({ id: s.id }).strict(),
    body: z.object({ status: billingStatus }).strict(),
    response: billingView,
    run: ({ user, params, body }) =>
      billing.setStatus(user.id, params.id, body.status),
  });
  contract(app, {
    method: "GET",
    url: "/platform/summary",
    tag: "Platform administration",
    summary: "Read platform-wide aggregates for the administration dashboard",
    response: z.object({
      users: z.object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        suspended: z.number().int().nonnegative(),
        verified: z.number().int().nonnegative(),
        createdLast7Days: z.number().int().nonnegative(),
        createdLast30Days: z.number().int().nonnegative(),
      }),
      organizations: z.object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        suspended: z.number().int().nonnegative(),
        createdLast30Days: z.number().int().nonnegative(),
      }),
      memberships: z.object({ total: z.number().int().nonnegative() }),
      sessions: z.object({ active: z.number().int().nonnegative() }),
      // Byte counters are returned as decimal strings on purpose: BigInt values
      // would be coerced to Number by the contract projection and lose precision.
      storage: z.object({
        usedBytes: z.string(),
        limitBytes: z.string(),
        reservedBytes: z.string(),
      }),
      billing: z.object({
        currency: z.literal("USD"),
        basePriceMinor: z.literal(1400),
        memberPriceMinor: z.literal(500),
        billableOrganizationCount: z.number().int().nonnegative(),
        billableMemberCount: z.number().int().nonnegative(),
        estimatedMonthlyMinor: z.number().int().nonnegative(),
      }),
      generatedAt: s.date,
    }),
    run: ({ user }) => platform.summary(user.id),
  });
  contract(app, {
    method: "GET",
    url: "/platform/audit",
    tag: "Platform administration",
    summary: "Read the global audit trail (superadmin only)",
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: s.id.optional(),
        action: z.string().trim().min(1).max(128).optional(),
        actorId: s.id.optional(),
        targetType: z.string().trim().min(1).max(128).optional(),
        targetId: s.id.optional(),
        from: s.date.optional(),
        to: s.date.optional(),
      })
      .strict(),
    response: z.object({
      items: z.array(s.auditEvent),
      nextCursor: s.id.nullable(),
    }),
    run: ({ user, query }) =>
      operatorLogs(user.id, {
        ...query,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      }),
  });
  const northPlatformGrant = z.object({ userId: s.id, capability: z.enum(northGlobalCapabilities), createdAt: s.date });
  contract(app, {
    method: "GET", url: "/platform/users/:id/north-capabilities", tag: "NORTH authorization",
    summary: "List explicit global NORTH capabilities for a GBP admin", params: z.object({ id: s.id }),
    response: z.array(northPlatformGrant), run: ({ user, params }) => northPlatformPermissions.list(user.id, params.id),
  });
  contract(app, {
    method: "POST", url: "/platform/users/:id/north-capabilities", tag: "NORTH authorization",
    summary: "Grant an explicit global NORTH capability as superadmin", params: z.object({ id: s.id }),
    body: z.object({ capability: z.enum(northGlobalCapabilities) }).strict(), response: northPlatformGrant, status: 201,
    run: ({ user, params, body }) => northPlatformPermissions.grant(user.id, params.id, body.capability),
  });
  contract(app, {
    method: "DELETE", url: "/platform/users/:id/north-capabilities/:capability", tag: "NORTH authorization",
    summary: "Revoke an explicit global NORTH capability as superadmin", params: z.object({ id: s.id, capability: z.enum(northGlobalCapabilities) }),
    response: z.null(), run: ({ user, params }) => northPlatformPermissions.revoke(user.id, params.id, params.capability),
  });
}
