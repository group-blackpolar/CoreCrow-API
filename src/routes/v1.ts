import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../contracts/route.js";
import * as s from "../contracts/schemas.js";
import { tenants } from "../modules/tenancy/service.js";
import { invitations } from "../modules/tenancy/invitation-service.js";
import { platform } from "../modules/platform/service.js";
import { billing } from "../modules/billing/service.js";
import { commerce } from "../modules/commerce/service.js";
import { identities } from "../modules/identity/repository.js";
import {
  CURRENT_TERMS_VERSION,
  users,
  requireOperator,
} from "../modules/identity/service.js";
import { northCapabilities, northGlobalCapabilities, permissions } from "../modules/authorization/policy.js";
import { authorizationGroups } from "../modules/authorization/groups-service.js";
import { transaction } from "../shared/transaction.js";
import { auditRepository } from "../modules/audit/repository.js";
import { createContact, listContacts } from "../modules/business/service.js";
import { fail } from "../shared/errors.js";
import { security, keyScopes } from "../modules/security/service.js";
import { changeTemporaryPassword } from "../modules/identity/temporary-password-service.js";
import {
  confirmEmailVerificationCode,
  requestEmailVerificationCode,
} from "../modules/identity/email-verification-service.js";
import { northPermissions, northPlatformPermissions, northTaxonomy } from "../modules/north/service.js";
import { northContent } from "../modules/north/content-service.js";
import { northPanelDocumentInput } from "../modules/north/content-schema.js";
import { northAssets } from "../modules/north/asset-service.js";
import { northTemplates } from "../modules/north/template-service.js";
import { northTemplateCreateInput, northTemplateSnapshotInput } from "../modules/north/template-schema.js";
import { northSearch } from "../modules/north/search-service.js";
import { hasNorthCapability } from "../modules/north/authorization.js";
import { authorize } from "../modules/authorization/service.js";

export async function v1Routes(app: FastifyInstance) {
  const key = z.object({
    id: s.id,
    name: s.name,
    prefix: z.string(),
    scopes: z.array(z.string()),
    lastUsed: s.date.nullable(),
    expiresAt: s.date,
    revokedAt: s.date.nullable(),
    createdAt: s.date,
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/assets/uploads", tag: "NORTH assets",
    summary: "Reserve quota and request a checksum-bound signed asset upload", params: s.orgParams,
    body: z.object({
      filename: z.string().trim().min(1).max(255),
      mime: z.string().trim().min(1).max(127),
      size: z.number().int().min(1),
      checksum: z.string().regex(/^[0-9a-fA-F]{64}$/),
    }).strict(),
    response: z.object({ asset: s.northAsset, upload: s.northSignedObjectRequest }), status: 201,
    run: ({ user, params, body }) => northAssets.requestUpload(user.id, params.organizationId, body),
  });
  const assetParams = s.orgParams.extend({ assetId: s.id });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/assets/:assetId/confirm", tag: "NORTH assets",
    summary: "Inspect, validate, scan, and atomically make an uploaded asset ready", params: assetParams,
    response: s.northAsset,
    run: ({ user, params }) => northAssets.confirm(user.id, params.organizationId, params.assetId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/assets/:assetId/read", tag: "NORTH assets",
    summary: "Re-authorize and issue a short-lived signed read for a ready asset", params: assetParams,
    response: z.object({ asset: s.northAsset, download: s.northSignedObjectRequest }),
    run: ({ user, params }) => northAssets.signedRead(user.id, params.organizationId, params.assetId),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/assets/:assetId", tag: "NORTH assets",
    summary: "Soft-delete an asset, release quota, and request physical object deletion", params: assetParams,
    response: z.null(),
    run: ({ user, params }) => northAssets.delete(user.id, params.organizationId, params.assetId),
  });
  contract(app, {
    method: "POST",
    url: "/identity/verification/send",
    tag: "Identity",
    summary: "Send or replace a single-use six-digit email verification code",
    public: true,
    body: s.verificationEmailInput,
    response: z.object({ accepted: z.literal(true) }),
    rateLimit: 10,
    run: ({ body }) => requestEmailVerificationCode(body.email),
  });
  contract(app, {
    method: "POST",
    url: "/identity/verification/confirm",
    tag: "Identity",
    summary: "Confirm a single-use six-digit email verification code",
    public: true,
    body: s.verificationCodeInput,
    response: z.object({ verified: z.literal(true) }),
    rateLimit: 20,
    run: ({ body }) => confirmEmailVerificationCode(body.email, body.code),
  });
  contract(app, {
    method: "GET",
    url: "/identity/config",
    tag: "Identity",
    summary: "Read public identity and onboarding capabilities",
    public: true,
    response: z.object({
      termsVersion: z.string(),
      passwordMinLength: z.number().int(),
      passwordMaxLength: z.number().int(),
      googleAuthEnabled: z.boolean(),
      captchaRequired: z.literal(false),
    }),
    run: async () => ({
      termsVersion: CURRENT_TERMS_VERSION,
      passwordMinLength: 12,
      passwordMaxLength: 128,
      googleAuthEnabled: Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
      ),
      captchaRequired: false as const,
    }),
  });
  contract(app, {
    method: "GET",
    url: "/security/keys",
    tag: "Security",
    summary: "List your API keys without secrets",
    response: z.array(key),
    run: ({ user }) => security.list(user.id),
  });
  contract(app, {
    method: "POST",
    url: "/me/change-temporary-password",
    tag: "Identity",
    summary: "Replace a required temporary credential password",
    body: z.object({
      currentPassword: z.string().min(12).max(128),
      newPassword: z.string().min(12).max(128),
    }).strict(),
    response: s.user,
    rateLimit: 5,
    run: ({ user, body, request }) => {
      const sessionId = request.user?.sessionId;
      if (!sessionId)
        fail(401, "SESSION_REQUIRED", "A current browser session is required");
      return changeTemporaryPassword(
        user.id,
        sessionId,
        body.currentPassword,
        body.newPassword,
      );
    },
  });
  contract(app, {
    method: "POST",
    url: "/me/terms",
    tag: "Identity",
    summary: "Accept the current legal terms with a server timestamp",
    body: z.object({ version: z.string().min(1).max(64) }).strict(),
    response: s.user,
    run: ({ user, body }) => users.acceptTerms(user.id, body.version),
  });
  contract(app, {
    method: "POST",
    url: "/security/keys",
    tag: "Security",
    summary:
      "Issue a read-only API key valid for seven days; membership remains authoritative",
    body: z
      .object({
        name: s.name,
        scopes: z.array(z.enum(keyScopes)).min(1).max(2),
      })
      .strict(),
    response: key.extend({ token: z.string() }),
    status: 201,
    run: ({ user, body }) => security.create(user.id, body),
  });
  contract(app, {
    method: "DELETE",
    url: "/security/keys/:id",
    tag: "Security",
    summary: "Revoke your API key immediately",
    params: z.object({ id: s.id }).strict(),
    response: key,
    run: ({ user, params }) => security.revoke(user.id, params.id),
  });
  contract(app, {
    method: "GET",
    url: "/me",
    tag: "Identity",
    summary: "Read the authenticated identity",
    response: s.user,
    run: async ({ user }) => user,
  });
  contract(app, {
    method: "GET",
    url: "/users",
    tag: "Identity",
    summary: "List global users (operator only, maximum 50)",
    response: z.array(s.user),
    run: async ({ user }) => {
      await requireOperator(user.id);
      return identities.list();
    },
  });
  contract(app, {
    method: "POST",
    url: "/users",
    tag: "Identity",
    summary: "Create a credential identity (operator only)",
    body: z
      .object({
        name: s.name,
        email: z.string().email(),
        password: z.string().min(12).max(128),
        role: s.globalRole.default("USER"),
      })
      .strict(),
    response: s.user,
    status: 201,
    run: ({ user, body }) => users.create(user.id, body),
  });
  contract(app, {
    method: "PATCH",
    url: "/users/:id",
    tag: "Identity",
    summary: "Update a profile; global role changes require superadmin",
    params: z.object({ id: s.id }).strict(),
    body: z
      .object({ name: s.name.optional(), role: s.globalRole.optional() })
      .strict()
      .refine((v) => Object.keys(v).length > 0),
    response: s.user,
    run: ({ user, params, body }) => users.update(user.id, params.id, body),
  });
  contract(app, {
    method: "DELETE",
    url: "/users/:id",
    tag: "Identity",
    summary: "Delete an identity without memberships (superadmin only)",
    params: z.object({ id: s.id }).strict(),
    response: z.null(),
    run: async ({ user, params }) => {
      await users.delete(user.id, params.id);
      return null;
    },
  });
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
    memberCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    billingStatus: z.enum(["ACTIVE", "PAST_DUE", "SUSPENDED", "CLOSED"]).nullable(),
    billingCurrency: z.string().nullable(),
  });
  contract(app, {
    method: "GET",
    url: "/platform/users",
    tag: "Platform administration",
    summary: "Search and page non-secret identity summaries (operator only)",
    query: pageQuery,
    response: z.object({
      items: z.array(s.user),
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
    method: "PATCH",
    url: "/platform/users/:id/status",
    tag: "Platform administration",
    summary: "Suspend or restore an identity and revoke all sessions (superadmin)",
    params: z.object({ id: s.id }).strict(),
    body: z.object({ status: s.accountStatus }).strict(),
    response: s.user,
    run: ({ user, params, body }) =>
      platform.setUserStatus(user.id, params.id, body.status),
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
  const billingStatus = z.enum(["ACTIVE", "PAST_DUE", "SUSPENDED", "CLOSED"]);
  const rawBillingProfile = z.object({
    id: s.id,
    organizationId: s.id,
    status: billingStatus,
    currency: z.literal("USD"),
    basePriceMinor: z.literal(1400),
    memberPriceMinor: z.literal(500),
    billingEmail: z.string().email().nullable(),
    createdAt: s.date,
    updatedAt: s.date,
  });
  const billingView = rawBillingProfile.extend({
    billableMemberCount: z.number().int().nonnegative(),
    groupsCostMinor: z.literal(0),
    estimatedMonthlyMinor: z.number().int().nonnegative(),
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
    method: "POST",
    url: "/organizations",
    tag: "Multi-tenancy",
    summary: "Create an organization with the current user as owner",
    body: z
      .object({
        name: s.name,
        slug: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional(),
      })
      .strict(),
    response: s.org,
    status: 201,
    run: ({ user, body }) => tenants.create(user.id, body),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/resolve/:slug",
    tag: "Multi-tenancy",
    summary: "Resolve the minimal public identity of an active organization",
    public: true,
    rateLimit: 60,
    params: z.object({ slug: z.string().trim().min(1).max(100) }).strict(),
    response: z.object({ name: s.name, slug: z.string() }),
    run: ({ params }) => tenants.resolvePublic(params.slug),
  });
  contract(app, {
    method: "GET",
    url: "/organizations",
    tag: "Multi-tenancy",
    summary: "List your organizations (up to 100)",
    response: z.array(s.org),
    run: ({ user }) => tenants.list(user.id),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId",
    tag: "Multi-tenancy",
    summary: "Read your organization",
    params: s.orgParams,
    response: s.org,
    run: ({ user, params }) => tenants.read(user.id, params.organizationId),
  });
  contract(app, {
    method: "PATCH",
    url: "/organizations/:organizationId",
    tag: "Multi-tenancy",
    summary: "Update an active organization's name or normalized slug",
    params: s.orgParams,
    body: z
      .object({
        name: s.name.optional(),
        slug: z.string().trim().min(1).max(100).optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0),
    response: s.org,
    run: ({ user, params, body }) =>
      tenants.update(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "PATCH",
    url: "/organizations/:organizationId/status",
    tag: "Multi-tenancy",
    summary: "Archive or restore an organization as its owner",
    params: s.orgParams,
    body: z.object({ status: z.enum(["ACTIVE", "ARCHIVED"]) }).strict(),
    response: s.org,
    run: ({ user, params, body }) =>
      tenants.setStatus(user.id, params.organizationId, body.status),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/members",
    tag: "Multi-tenancy",
    summary: "List members (up to 100)",
    params: s.orgParams,
    response: z.array(s.member),
    run: ({ user, params }) => tenants.members(user.id, params.organizationId),
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
    method: "PATCH",
    url: "/organizations/:organizationId/members/:userId",
    tag: "Authorization",
    summary: "Change a tenant role; protect the last owner",
    params: s.memberParams,
    body: z.object({ role: s.role }).strict(),
    response: s.member,
    run: ({ user, params, body }) =>
      tenants.changeMember(
        user.id,
        params.organizationId,
        params.userId,
        body.role,
      ),
  });
  contract(app, {
    method: "DELETE",
    url: "/organizations/:organizationId/members/:userId",
    tag: "Multi-tenancy",
    summary: "Remove a member; protect the last owner",
    params: s.memberParams,
    response: s.member,
    run: ({ user, params }) =>
      tenants.changeMember(user.id, params.organizationId, params.userId),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/permissions",
    tag: "Authorization",
    summary:
      "Resolve deterministic effective permissions from role, groups, and direct grants",
    params: s.orgParams,
    response: z.object({
      role: s.role,
      permissions: z.array(z.enum(permissions)),
    }),
    run: ({ user, params }) =>
      authorizationGroups.effective(user.id, params.organizationId),
  });
  const permissionBody = z
    .object({ permission: z.enum(permissions) })
    .strict();
  const permissionGrant = z.object({ permission: z.enum(permissions) });
  const groupView = s.organizationGroup.extend({
    memberUserIds: z.array(s.id),
    permissions: z.array(z.enum(permissions)),
  });
  const groupDescription = z.string().trim().max(500).nullable();
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/groups",
    tag: "Authorization",
    summary: "List organization groups and their explicit grants",
    params: s.orgParams,
    response: z.array(groupView),
    run: ({ user, params }) =>
      authorizationGroups.list(user.id, params.organizationId),
  });
  const invitationView = s.invitation.extend({
    permissions: z.array(z.enum(permissions)),
  });
  const invitationIssue = z
    .object({
      kind: s.invitationKind.default("EMAIL"),
      email: z.string().trim().email().max(254).optional(),
      role: z
        .enum(["ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"])
        .default("MEMBER"),
      expiresInHours: z.number().int().min(1).max(720).optional(),
      groupIds: z.array(s.id).max(50).default([]),
      permissions: z.array(z.enum(permissions)).max(50).default([]),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.kind === "EMAIL" && !value.email)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["email"],
          message: "Email invitations require an email",
        });
      if (value.kind === "CODE" && value.email)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["email"],
          message: "Generic codes cannot target an email",
        });
    });
  const issuedInvitation = invitationView.extend({
    token: z.string().optional(),
    delivery: z.enum(["sent", "failed", "not_applicable"]),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/invitations",
    tag: "Multi-tenancy",
    summary: "List invitation state without returning credentials",
    params: s.orgParams,
    response: z.array(invitationView),
    run: ({ user, params }) => invitations.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST",
    url: "/organizations/:organizationId/groups",
    tag: "Authorization",
    summary: "Create an organization authorization group",
    params: s.orgParams,
    body: z
      .object({ name: s.name, description: groupDescription.optional() })
      .strict(),
    response: s.organizationGroup,
    status: 201,
    run: ({ user, params, body }) =>
      authorizationGroups.create(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "PATCH",
    url: "/organizations/:organizationId/groups/:groupId",
    tag: "Authorization",
    summary: "Rename or describe an organization authorization group",
    params: s.groupParams,
    body: z
      .object({
        name: s.name.optional(),
        description: groupDescription.optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0),
    response: s.organizationGroup,
    run: ({ user, params, body }) =>
      authorizationGroups.update(
        user.id,
        params.organizationId,
        params.groupId,
        body,
      ),
  });
  contract(app, {
    method: "DELETE",
    url: "/organizations/:organizationId/groups/:groupId",
    tag: "Authorization",
    summary: "Delete an organization authorization group and its grants",
    params: s.groupParams,
    response: z.null(),
    run: async ({ user, params }) => {
      await authorizationGroups.remove(
        user.id,
        params.organizationId,
        params.groupId,
      );
      return null;
    },
  });
  contract(app, {
    method: "POST",
    url: "/organizations/:organizationId/groups/:groupId/members",
    tag: "Authorization",
    summary: "Add an existing same-organization member to a group",
    params: s.groupParams,
    body: z.object({ userId: s.id }).strict(),
    response: z.object({
      groupId: s.id,
      userId: s.id,
      createdAt: s.date,
    }),
    status: 201,
    run: ({ user, params, body }) =>
      authorizationGroups.addMember(
        user.id,
        params.organizationId,
        params.groupId,
        body.userId,
      ),
  });
  contract(app, {
    method: "DELETE",
    url: "/organizations/:organizationId/groups/:groupId/members/:userId",
    tag: "Authorization",
    summary: "Remove a same-organization member from a group",
    params: s.groupMemberParams,
    response: z.null(),
    run: async ({ user, params }) => {
      await authorizationGroups.removeMember(
        user.id,
        params.organizationId,
        params.groupId,
        params.userId,
      );
      return null;
    },
  });
  contract(app, {
    method: "POST",
    url: "/organizations/:organizationId/groups/:groupId/permissions",
    tag: "Authorization",
    summary: "Grant a registered permission to an organization group",
    params: s.groupParams,
    body: permissionBody,
    response: permissionGrant,
    status: 201,
    run: ({ user, params, body }) =>
      authorizationGroups.grantGroup(
        user.id,
        params.organizationId,
        params.groupId,
        body.permission,
      ),
  });
  contract(app, {
    method: "DELETE",
    url: "/organizations/:organizationId/groups/:groupId/permissions/:permission",
    tag: "Authorization",
    summary: "Revoke a registered permission from an organization group",
    params: s.groupParams.extend({ permission: z.enum(permissions) }),
    response: z.null(),
    run: async ({ user, params }) => {
      await authorizationGroups.revokeGroup(
        user.id,
        params.organizationId,
        params.groupId,
        params.permission,
      );
      return null;
    },
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/members/:userId/permission-grants",
    tag: "Authorization",
    summary: "List explicit direct permission grants for a member",
    params: s.memberParams,
    response: z.array(z.enum(permissions)),
    run: ({ user, params }) =>
      authorizationGroups.direct(
        user.id,
        params.organizationId,
        params.userId,
      ),
  });
  contract(app, {
    method: "POST",
    url: "/organizations/:organizationId/members/:userId/permission-grants",
    tag: "Authorization",
    summary: "Grant a registered permission directly to a member",
    params: s.memberParams,
    body: permissionBody,
    response: permissionGrant,
    status: 201,
    run: ({ user, params, body }) =>
      authorizationGroups.grantDirect(
        user.id,
        params.organizationId,
        params.userId,
        body.permission,
      ),
  });
  contract(app, {
    method: "DELETE",
    url: "/organizations/:organizationId/members/:userId/permission-grants/:permission",
    tag: "Authorization",
    summary: "Revoke a registered direct permission grant from a member",
    params: s.memberParams.extend({ permission: z.enum(permissions) }),
    response: z.null(),
    run: async ({ user, params }) => {
      await authorizationGroups.revokeDirect(
        user.id,
        params.organizationId,
        params.userId,
        params.permission,
      );
      return null;
    },
  });
  contract(app, {
    method: "POST",
    url: "/organizations/:organizationId/invitations",
    tag: "Multi-tenancy",
    summary: "Issue an email-specific invitation or generic single-use code",
    params: s.orgParams,
    body: invitationIssue,
    response: issuedInvitation,
    status: 201,
    run: ({ user, params, body }) =>
      invitations.issue(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "POST",
    url: "/invitations/accept",
    tag: "Multi-tenancy",
    summary:
      "Accept a single-use invitation with the verified recipient identity",
    body: z.object({ token: z.string().trim().min(8).max(128) }).strict(),
    response: s.member,
    rateLimit: 10,
    run: ({ user, body }) => invitations.accept(user, body.token),
  });
  contract(app, {
    method: "POST",
    url: "/organizations/:organizationId/invitations/:id/replace",
    tag: "Multi-tenancy",
    summary: "Revoke and replace an unaccepted invitation",
    params: s.orgParams.extend({ id: s.id }),
    response: issuedInvitation,
    status: 201,
    run: ({ user, params }) =>
      invitations.replace(user.id, params.organizationId, params.id),
  });
  contract(app, {
    method: "DELETE",
    url: "/organizations/:organizationId/invitations/:id",
    tag: "Multi-tenancy",
    summary: "Revoke an invitation",
    params: s.orgParams.extend({ id: s.id }),
    response: z.null(),
    run: async ({ user, params }) => {
      await invitations.revoke(user.id, params.organizationId, params.id);
      return null;
    },
  });
  const northUpdateMetadataBase = s.northMetadataInput.partial();
  const northUpdateMetadata = northUpdateMetadataBase.refine((value) => Object.keys(value).length > 0);
  const categoryParams = s.orgParams.extend({ categoryId: s.id });
  const subcategoryParams = s.orgParams.extend({ subcategoryId: s.id });
  const panelParams = s.orgParams.extend({ panelId: s.id });
  const panelRevisionParams = panelParams.extend({ revisionId: s.id });
  const revisionSummary = z.object({
    id: s.id, panelId: s.id, revisionNumber: z.number().int().min(1), etag: z.string(),
    defaultLocale: z.string(), fallbackLocales: z.array(z.string()), message: z.string().nullable(),
    publishAt: s.date.nullable(), unpublishAt: s.date.nullable(), createdBy: s.id, createdAt: s.date,
  });
  const panelRevision = revisionSummary.extend({ document: northPanelDocumentInput });
  const ifMatch = (request: { headers: Record<string, unknown> }) => {
    const value = request.headers["if-match"];
    return Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined;
  };
  const navigationPanel = z.object({ id: s.id, name: s.localizedText, icon: z.string().nullable(), slug: z.string(), status: s.northPanelStatus });
  const navigation = z.array(z.object({
    id: s.id, name: s.localizedText, icon: z.string().nullable(), color: z.string().nullable(), slug: z.string(),
    subcategories: z.array(z.object({ id: s.id, name: s.localizedText, icon: z.string().nullable(), slug: z.string(), panels: z.array(navigationPanel) })),
  }));
  const managementTree = z.array(s.northCategory.extend({
    subcategories: z.array(s.northSubcategory.extend({
      panels: z.array(s.northPanel),
    })),
  }));
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/navigation", tag: "NORTH taxonomy",
    summary: "Read compact server-authorized organization navigation", params: s.orgParams, response: navigation,
    run: ({ user, params }) => northTaxonomy.navigation(user.id, params.organizationId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/management-tree", tag: "NORTH taxonomy",
    summary: "Read complete tenant taxonomy metadata for authorized organization management", params: s.orgParams,
    response: managementTree,
    run: ({ user, params }) => northTaxonomy.managementTree(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/categories", tag: "NORTH taxonomy",
    summary: "Create an organization content category", params: s.orgParams,
    body: s.northMetadataInput.extend({ categoryClass: z.literal("CUSTOM").default("CUSTOM"), resourceKind: z.literal("CONTENT").default("CONTENT") }).strict(),
    response: s.northCategory, status: 201,
    run: ({ user, params, body }) => northTaxonomy.createCategory(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/categories/:categoryId", tag: "NORTH taxonomy",
    summary: "Update category metadata while preserving its stable ID", params: categoryParams, body: northUpdateMetadata,
    response: s.northCategory, run: ({ user, params, body }) => northTaxonomy.updateCategory(user.id, params.organizationId, params.categoryId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/categories/:categoryId/archive", tag: "NORTH taxonomy",
    summary: "Archive a content category", params: categoryParams, response: s.northCategory,
    run: ({ user, params }) => northTaxonomy.archiveCategory(user.id, params.organizationId, params.categoryId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/categories/:categoryId/subcategories", tag: "NORTH taxonomy",
    summary: "Create a subcategory", params: categoryParams,
    body: s.northMetadataInput.extend({ resourceKind: z.literal("CONTENT").default("CONTENT") }).strict(), response: s.northSubcategory, status: 201,
    run: ({ user, params, body }) => northTaxonomy.createSubcategory(user.id, params.organizationId, params.categoryId, body),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/subcategories/:subcategoryId", tag: "NORTH taxonomy",
    summary: "Update or move a same-tenant subcategory", params: subcategoryParams,
    body: northUpdateMetadataBase.extend({ categoryId: s.id.optional() }).refine((value) => Object.keys(value).length > 0), response: s.northSubcategory,
    run: ({ user, params, body }) => northTaxonomy.updateSubcategory(user.id, params.organizationId, params.subcategoryId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/subcategories/:subcategoryId/archive", tag: "NORTH taxonomy",
    summary: "Archive a content subcategory", params: subcategoryParams, response: s.northSubcategory,
    run: ({ user, params }) => northTaxonomy.archiveSubcategory(user.id, params.organizationId, params.subcategoryId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/subcategories/:subcategoryId/panels", tag: "NORTH taxonomy",
    summary: "Create panel metadata", params: subcategoryParams,
    body: s.northMetadataInput.extend({ resourceKind: z.literal("CONTENT").default("CONTENT"), audienceType: s.northAudienceType.default("ALL_MEMBERS") }).strict(), response: s.northPanel, status: 201,
    run: ({ user, params, body }) => northTaxonomy.createPanel(user.id, params.organizationId, params.subcategoryId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId", tag: "NORTH taxonomy",
    summary: "Read authorized panel metadata", params: panelParams, response: s.northPanel,
    run: ({ user, params }) => northTaxonomy.readPanel(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/panels/:panelId", tag: "NORTH taxonomy",
    summary: "Update or move same-tenant panel metadata", params: panelParams,
    body: northUpdateMetadataBase.extend({ subcategoryId: s.id.optional() }).refine((value) => Object.keys(value).length > 0), response: s.northPanel,
    run: ({ user, params, body }) => northTaxonomy.updatePanel(user.id, params.organizationId, params.panelId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/archive", tag: "NORTH taxonomy",
    summary: "Archive a content panel", params: panelParams, response: s.northPanel,
    run: ({ user, params }) => northTaxonomy.archivePanel(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/draft", tag: "NORTH content",
    summary: "Preview the current authorized panel draft", params: panelParams, response: panelRevision,
    run: async ({ user, params, reply }) => {
      const revision = await northContent.draft(user.id, params.organizationId, params.panelId);
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/panels/:panelId/draft", tag: "NORTH content",
    summary: "Autosave a validated immutable draft revision using optimistic concurrency", params: panelParams,
    headers: { properties: { "if-match": { type: "string", description: "Strong ETag of the current draft; optional only when no draft exists" } } },
    body: z.object({ document: z.record(z.string(), z.unknown()), message: z.string().trim().max(500).optional(), publishAt: s.date.optional(), unpublishAt: s.date.optional() }).strict(),
    response: panelRevision,
    run: async ({ user, params, body, request, reply }) => {
      const revision = await northContent.saveDraft(user.id, params.organizationId, params.panelId, ifMatch(request), body);
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/publish", tag: "NORTH content",
    summary: "Publish the exact current draft revision", params: panelParams, response: panelRevision,
    headers: { properties: { "if-match": { type: "string", description: "Strong ETag of the current draft" } }, required: ["if-match"] },
    run: async ({ user, params, request, reply }) => {
      const revision = await northContent.publish(user.id, params.organizationId, params.panelId, ifMatch(request));
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/revisions", tag: "NORTH content",
    summary: "List immutable panel revision history", params: panelParams, response: z.array(revisionSummary),
    run: ({ user, params }) => northContent.history(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/revisions/:revisionId", tag: "NORTH content",
    summary: "Read one immutable panel revision", params: panelRevisionParams, response: panelRevision,
    run: async ({ user, params, reply }) => {
      const revision = await northContent.revision(user.id, params.organizationId, params.panelId, params.revisionId);
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/panels/:panelId/revisions/:revisionId/restore", tag: "NORTH content",
    summary: "Restore an immutable snapshot as a new draft revision", params: panelRevisionParams,
    headers: { properties: { "if-match": { type: "string", description: "Strong ETag of the current draft" } }, required: ["if-match"] },
    body: z.object({ message: z.string().trim().max(500).optional() }).strict(), response: panelRevision, status: 201,
    run: async ({ user, params, body, request, reply }) => {
      const revision = await northContent.restore(user.id, params.organizationId, params.panelId, params.revisionId, ifMatch(request), body.message);
      reply.header("ETag", revision.etag);
      return revision;
    },
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/reorder", tag: "NORTH taxonomy",
    summary: "Transactionally reorder one complete sibling list", params: s.orgParams,
    body: z.object({ kind: z.enum(["CATEGORY", "SUBCATEGORY", "PANEL"]), parentId: s.id.optional(), ids: z.array(s.id).max(100) }).strict(),
    response: z.object({ updated: z.number().int().nonnegative() }),
    run: ({ user, params, body }) => northTaxonomy.reorder(user.id, params.organizationId, body.kind, body.parentId, body.ids),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/clone", tag: "NORTH taxonomy",
    summary: "Clone content taxonomy with new stable IDs inside the same tenant", params: s.orgParams,
    body: z.object({ kind: z.enum(["CATEGORY", "SUBCATEGORY", "PANEL"]), sourceId: s.id, destinationParentId: s.id.optional(), slug: z.string().trim().min(1).max(100) }).strict(),
    response: z.union([s.northCategory, s.northSubcategory, s.northPanel]), status: 201,
    run: ({ user, params, body }) => northTaxonomy.clone(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/panels/:panelId/audience", tag: "NORTH authorization",
    summary: "Replace a panel audience with same-tenant selectors", params: panelParams,
    body: z.object({ type: s.northAudienceType, roles: z.array(s.role).max(10).optional(), groupIds: z.array(s.id).max(100).optional(), capabilities: z.array(z.enum(northCapabilities)).max(100).optional(), membershipIds: z.array(s.id).max(100).optional() }).strict(),
    response: s.northPanel,
    run: ({ user, params, body }) => northTaxonomy.setAudience(user.id, params.organizationId, params.panelId, body),
  });
  const northAudience = z.object({
    type: s.northAudienceType,
    roles: z.array(s.role),
    groupIds: z.array(s.id),
    capabilities: z.array(z.enum(northCapabilities)),
    membershipIds: z.array(s.id),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/panels/:panelId/audience", tag: "NORTH authorization",
    summary: "Read the complete authorized selector set for a panel audience", params: panelParams,
    response: northAudience,
    run: ({ user, params }) => northTaxonomy.audience(user.id, params.organizationId, params.panelId),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/home-panel", tag: "NORTH taxonomy",
    summary: "Select a published authorized organization home panel or system fallback", params: s.orgParams,
    body: z.object({ panelId: s.id.nullable() }).strict(), response: z.object({ homePanelId: s.id.nullable() }),
    run: ({ user, params, body }) => northTaxonomy.setHome(user.id, params.organizationId, body.panelId),
  });
  const northGrant = z.object({
    id: s.id, organizationId: s.id, capability: z.enum(northCapabilities), scope: s.northPermissionScope,
    role: s.role.optional(), groupId: s.id.optional(), membershipId: s.id.optional(),
    categoryId: s.id.nullable(), subcategoryId: s.id.nullable(), panelId: s.id.nullable(), createdAt: s.date,
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/permission-grants", tag: "NORTH authorization",
    summary: "List scoped role, group, and direct NORTH grants", params: s.orgParams,
    response: z.object({ roles: z.array(northGrant), groups: z.array(northGrant), memberships: z.array(northGrant) }),
    run: ({ user, params }) => northPermissions.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/permission-subjects", tag: "NORTH authorization",
    summary: "List tenant-scoped roles, groups, and labeled memberships for NORTH grant selection", params: s.orgParams,
    response: z.object({
      roles: z.array(s.role),
      groups: z.array(z.object({ id: s.id, name: s.name })),
      memberships: z.array(z.object({ id: s.id, userId: s.id, name: z.string().nullable(), role: s.role })),
    }),
    run: ({ user, params }) => northPermissions.subjects(user.id, params.organizationId),
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
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/permission-grants", tag: "NORTH authorization",
    summary: "Create a scoped additive grant with anti-escalation enforcement", params: s.orgParams,
    body: z.object({ subjectType: z.enum(["ROLE", "GROUP", "MEMBERSHIP"]), role: s.role.optional(), groupId: s.id.optional(), membershipId: s.id.optional(), capability: z.enum(northCapabilities), scope: s.northPermissionScope, resourceId: s.id.optional() }).strict(),
    response: northGrant, status: 201,
    run: ({ user, params, body }) => northPermissions.grant(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/north/permission-grants/:id", tag: "NORTH authorization",
    summary: "Revoke an authorized scoped NORTH grant", params: s.orgParams.extend({ id: s.id }), response: z.null(),
    run: ({ user, params }) => northPermissions.revoke(user.id, params.organizationId, params.id),
  });
  const northTemplate = z.object({
    id: s.id,
    slug: z.string(),
    name: s.localizedText,
    description: s.localizedText.nullable(),
    status: s.northResourceStatus,
    currentVersion: z.number().int().min(1),
    createdBy: s.id,
    createdAt: s.date,
    updatedAt: s.date,
  });
  const northTemplateDetail = northTemplate.extend({
    version: z.number().int().min(1),
    snapshot: northTemplateSnapshotInput,
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/templates", tag: "NORTH templates",
    summary: "List active global templates authorized for an organization", params: s.orgParams,
    response: z.array(northTemplate),
    run: ({ user, params }) => northTemplates.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/templates/:templateId", tag: "NORTH templates",
    summary: "Read an immutable global template version", params: s.orgParams.extend({ templateId: s.id }),
    query: z.object({ version: z.coerce.number().int().min(1).optional() }).strict(),
    response: northTemplateDetail,
    run: ({ user, params, query }) => northTemplates.read(user.id, params.organizationId, params.templateId, query.version),
  });
  contract(app, {
    method: "POST", url: "/platform/north/templates", tag: "NORTH templates",
    summary: "Create a versioned global template as an authorized platform administrator",
    body: northTemplateCreateInput, response: northTemplate, status: 201,
    run: ({ user, body }) => northTemplates.create(user.id, body),
  });
  contract(app, {
    method: "GET", url: "/platform/north/templates", tag: "NORTH templates",
    summary: "List global templates including archived entries for platform management",
    response: z.array(northTemplate),
    run: ({ user }) => northTemplates.platformList(user.id),
  });
  contract(app, {
    method: "PATCH", url: "/platform/north/templates/:templateId", tag: "NORTH templates",
    summary: "Update or archive global template metadata without mutating existing tenant copies",
    params: z.object({ templateId: s.id }).strict(),
    body: z.object({
      slug: z.string().trim().min(1).max(100).optional(),
      name: s.localizedText.optional(),
      description: s.localizedText.nullable().optional(),
      status: s.northResourceStatus.optional(),
    }).strict().refine((value) => Object.keys(value).length > 0),
    response: northTemplate,
    run: ({ user, params, body }) => northTemplates.update(user.id, params.templateId, body),
  });
  contract(app, {
    method: "POST", url: "/platform/north/templates/:templateId/versions", tag: "NORTH templates",
    summary: "Append an immutable version to a global template", params: z.object({ templateId: s.id }).strict(),
    body: z.object({ snapshot: northTemplateSnapshotInput }).strict(),
    response: z.object({ id: s.id, templateId: s.id, version: z.number().int().min(1), snapshot: northTemplateSnapshotInput, createdBy: s.id, createdAt: s.date }),
    status: 201,
    run: ({ user, params, body }) => northTemplates.createVersion(user.id, params.templateId, body.snapshot),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/north/templates/:templateId/apply", tag: "NORTH templates",
    summary: "Apply one immutable template version as an independent tenant-owned draft copy",
    params: s.orgParams.extend({ templateId: s.id }),
    body: z.object({ version: z.number().int().min(1).optional(), slug: z.string().trim().min(1).max(100).optional() }).strict(),
    response: s.northCategory, status: 201,
    run: ({ user, params, body }) => northTemplates.apply(user.id, params.organizationId, params.templateId, body),
  });
  const northSearchResult = z.object({
    id: s.id,
    resourceType: z.enum(["CATEGORY", "SUBCATEGORY", "PANEL", "ASSET"]),
    name: s.localizedText,
    description: s.localizedText.nullable(),
    status: z.string(),
    categoryId: s.id.nullable(),
    subcategoryId: s.id.nullable(),
    panelId: s.id.nullable(),
    updatedAt: s.date,
    updatedBy: s.id.nullable(),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/north/search", tag: "NORTH search",
    summary: "Search only tenant-scoped resources authorized for the current principal", params: s.orgParams,
    query: z.object({
      query: z.string().trim().min(1).max(200),
      resourceType: z.enum(["CATEGORY", "SUBCATEGORY", "PANEL", "ASSET"]).optional(),
      categoryId: s.id.optional(),
      status: z.enum(["ACTIVE", "DRAFT", "PUBLISHED", "ARCHIVED", "READY"]).optional(),
      updatedBy: s.id.optional(),
      updatedAfter: s.date.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict(),
    response: z.array(northSearchResult),
    run: ({ user, params, query }) => northSearch.run(user.id, params.organizationId, query),
  });
  contract(app, {
    method: "GET", url: "/content/resolve", tag: "NORTH content",
    summary: "Resolve one exact authorized published panel document without enumeration", query: z.object({ organizationSlug: z.string(), categorySlug: z.string(), subcategorySlug: z.string(), panelSlug: z.string(), locale: z.string().optional() }).strict(),
    response: z.object({
      organization: z.object({ name: s.name, slug: z.string() }),
      category: z.object({ id: s.id, name: s.localizedText, slug: z.string() }),
      subcategory: z.object({ id: s.id, name: s.localizedText, slug: z.string() }),
      panel: z.object({ id: s.id, name: s.localizedText, description: s.localizedText.nullable(), icon: z.string().nullable(), slug: z.string(), status: z.literal("PUBLISHED") }),
      revision: panelRevision.extend({ locale: z.object({ requested: z.string().nullable(), resolved: z.string(), fallbackChain: z.array(z.string()) }) }).nullable(),
      canonicalPath: z.string(),
    }),
    run: ({ user, query }) => northTaxonomy.resolve(user.id, query),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/audit",
    tag: "Audit",
    summary: "Read controlled audit records",
    params: s.orgParams,
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        before: s.date.optional(),
      })
      .strict(),
    response: z.array(s.auditEvent),
    run: ({ user, params, query }) =>
      transaction(async (tx) => {
        try {
          await authorize(tx, user.id, params.organizationId, "audit.read");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "statusCode" in error &&
            error.statusCode === 403 &&
            await hasNorthCapability(tx, user.id, "north.audit.read", { organizationId: params.organizationId, scope: "ORGANIZATION" })
          )) throw error;
        }
        await auditRepository.append(tx, {
          actorId: user.id,
          organizationId: params.organizationId,
          action: "audit.read",
        });
        return auditRepository.list(
          params.organizationId,
          query.limit,
          query.before ? new Date(query.before) : undefined,
        );
      }),
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
  contract(app, {
    method: "POST",
    url: "/contact",
    tag: "Business services",
    summary: "Submit a public contact request with consent",
    public: true,
    rateLimit: 5,
    body: s.contactInput,
    response: z.object({ id: s.id, createdAt: s.date }),
    status: 201,
    run: ({ body }) => {
      const { consent: _, ...data } = body;
      return createContact(data);
    },
  });
  contract(app, {
    method: "GET",
    url: "/contact",
    tag: "Business services",
    summary: "Read contact requests (operator only, audited)",
    query: z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .strict(),
    response: z.array(
      s.contactInput
        .omit({ consent: true })
        .extend({ id: s.id, createdAt: s.date, consentAt: s.date }),
    ),
    run: ({ user, query }) => listContacts(user.id, query.limit),
  });
}
