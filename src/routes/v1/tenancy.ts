import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../../contracts/route.js";
import * as s from "../../contracts/schemas.js";
import { tenants } from "../../modules/tenancy/service.js";
import { invitations } from "../../modules/tenancy/invitation-service.js";
import { organizationPolicy } from "../../modules/tenancy/policy.js";
import { accessSimulation } from "../../modules/authorization/access-simulation.js";
import { accessRequests } from "../../modules/authorization/access-requests.js";
import { accessTemplates } from "../../modules/authorization/access-templates.js";
import { permissions } from "../../modules/authorization/policy.js";
import { authorizationGroups } from "../../modules/authorization/groups-service.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../../modules/audit/repository.js";
import { northAssets } from "../../modules/north/asset-service.js";
import { hasNorthCapability } from "../../modules/north/authorization.js";
import { authorize } from "../../modules/authorization/service.js";

export async function tenancyRoutes(app: FastifyInstance) {
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/icon", tag: "NORTH assets",
    summary: "Signed read of the managed organization icon (any member who can read the organization)", params: s.orgParams,
    response: z.object({ download: s.northSignedObjectRequest }),
    run: ({ user, params }) => northAssets.signedIconRead(user.id, params.organizationId),
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
    summary: "Update an active organization's name, normalized slug, icon or brand colors",
    params: s.orgParams,
    body: z
      .object({
        name: s.name.optional(),
        slug: z.string().trim().min(1).max(100).optional(),
        iconData: z.string().max(400_000).nullable().optional(),
        iconAssetId: s.id.nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        brandPrimary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
        brandAccent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
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
    summary: "List members with minimal tenant-visible identity (up to 100)",
    params: s.orgParams,
    response: z.array(s.organizationMember),
    run: ({ user, params }) => tenants.members(user.id, params.organizationId),
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
  const ACCESS_STATUS = z.enum(["PENDING", "APPROVED", "DENIED", "CANCELLED"]);
  const directPermissionBody = permissionBody.extend({ days: z.number().int().min(1).max(365).optional() }).strict();
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
  const orgPolicy = z.object({ defaultMemberRole: z.enum(["VIEWER", "MEMBER", "BILLING_ADMIN"]), defaultGroupIds: z.array(s.id).max(50), importRetentionDays: z.number().int().min(1).max(3650).nullable() });
  const invitationView = s.invitation.extend({
    permissions: z.array(z.enum(permissions)),
  });
  const invitationIssue = z
    .object({
      kind: s.invitationKind.default("EMAIL"),
      email: z.string().trim().email().max(254).optional(),
      role: z
        .enum(["ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"])
        .optional(),
      expiresInHours: z.number().int().min(1).max(720).optional(),
      maxUses: z.number().int().min(1).max(1000).optional(),
      groupIds: z.array(s.id).max(50).optional(),
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
    query: z.object({ archived: z.enum(["true", "false"]).default("false") }),
    response: z.array(invitationView),
    run: ({ user, params, query }) => invitations.list(user.id, params.organizationId, query.archived === "true"),
  });
  for (const action of ["archive", "restore"] as const)
    contract(app, {
      method: "POST",
      url: `/organizations/:organizationId/invitations/:id/${action}`,
      tag: "Multi-tenancy",
      summary: action === "archive" ? "Hide a finished invitation from the working list" : "Show an archived invitation again",
      params: s.orgParams.extend({ id: s.id }),
      response: z.null(),
      run: async ({ user, params }) => {
        await invitations.archive(user.id, params.organizationId, params.id, action === "archive");
        return null;
      },
    });
  contract(app, {
    method: "DELETE",
    url: "/organizations/:organizationId/invitations/:id/permanent",
    tag: "Multi-tenancy",
    summary: "Permanently delete a revoked or expired invitation that was never accepted",
    params: s.orgParams.extend({ id: s.id }),
    response: z.null(),
    run: async ({ user, params }) => {
      await invitations.deletePermanently(user.id, params.organizationId, params.id);
      return null;
    },
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
  const accessRequestView = z.object({
    id: s.id, permission: z.enum(permissions), reason: z.string(), requestedDays: z.number().int().nullable(), status: ACCESS_STATUS,
    decidedBy: s.id.nullable(), decidedAt: s.date.nullable(), decisionNote: z.string().nullable(), grantExpiresAt: s.date.nullable(), createdAt: s.date,
    requester: z.object({ userId: s.id, name: z.string().nullable(), email: z.string() }).nullable(),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/access-requests", tag: "Authorization",
    summary: "Ask for a registered permission with a reason (any member; one open request per permission)", params: s.orgParams,
    body: z.object({ permission: z.string().min(1).max(64), reason: z.string().trim().min(5).max(500), days: z.number().int().min(1).max(365).optional() }).strict(),
    response: accessRequestView, status: 201, rateLimit: 20,
    run: ({ user, params, body }) => accessRequests.create(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/access-requests", tag: "Authorization",
    summary: "List your own requests, or the whole queue with permissions.manage", params: s.orgParams,
    query: z.object({ scope: z.enum(["mine", "all"]).default("mine"), status: ACCESS_STATUS.optional() }),
    response: z.array(accessRequestView),
    run: ({ user, params, query }) => accessRequests.list(user.id, params.organizationId, query.scope, query.status),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/access-requests/:requestId/cancel", tag: "Authorization",
    summary: "Withdraw your own open request", params: s.orgParams.extend({ requestId: s.id }), response: z.null(),
    run: ({ user, params }) => accessRequests.cancel(user.id, params.organizationId, params.requestId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/access-requests/:requestId/decision", tag: "Authorization",
    summary: "Approve (optionally time-boxed) or deny a request; needs permissions.manage and holding the permission", params: s.orgParams.extend({ requestId: s.id }),
    body: z.object({ decision: z.enum(["APPROVE", "DENY"]), note: z.string().trim().max(500).optional(), days: z.number().int().min(1).max(365).nullable().optional() }).strict(),
    response: accessRequestView, rateLimit: 60,
    run: ({ user, params, body }) => accessRequests.decide(user.id, params.organizationId, params.requestId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/members/:userId/permission-grants/details", tag: "Authorization",
    summary: "Active direct grants of a member with their expiry", params: s.memberParams,
    response: z.array(z.object({ permission: z.enum(permissions), expiresAt: s.date.nullable(), grantedBy: s.id.nullable() })),
    run: ({ user, params }) => authorizationGroups.directDetails(user.id, params.organizationId, params.userId),
  });
  const templateView = z.object({
    id: s.id, name: z.string(), description: z.string().nullable(), role: z.enum(["VIEWER", "MEMBER", "BILLING_ADMIN", "ADMIN"]),
    permissions: z.array(z.enum(permissions)), datasetIds: z.array(s.id), groupIds: z.array(s.id), updatedAt: s.date,
  });
  const templateInput = z.object({
    name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).nullable().optional(),
    role: z.enum(["VIEWER", "MEMBER", "BILLING_ADMIN", "ADMIN"]), permissions: z.array(z.enum(permissions)).max(50).default([]),
    datasetIds: z.array(s.id).max(100).default([]), groupIds: z.array(s.id).max(50).default([]),
  }).strict();
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/access-templates", tag: "Authorization",
    summary: "List the organization's access templates (needs members.manage or permissions.manage)", params: s.orgParams, response: z.array(templateView),
    run: ({ user, params }) => accessTemplates.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/access-templates", tag: "Authorization",
    summary: "Create an access template: role, direct permissions, groups and dataset access", params: s.orgParams, body: templateInput, response: templateView, status: 201,
    run: ({ user, params, body }) => accessTemplates.save(user.id, params.organizationId, null, body),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/access-templates/:templateId", tag: "Authorization",
    summary: "Replace an access template", params: s.orgParams.extend({ templateId: s.id }), body: templateInput, response: templateView,
    run: ({ user, params, body }) => accessTemplates.save(user.id, params.organizationId, params.templateId, body),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/access-templates/:templateId", tag: "Authorization",
    summary: "Delete an access template (accounts already created keep what they were given)", params: s.orgParams.extend({ templateId: s.id }), response: z.null(),
    run: ({ user, params }) => accessTemplates.remove(user.id, params.organizationId, params.templateId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/members/:userId/apply-template", tag: "Authorization",
    summary: "Apply an access template to an existing member (role, permissions, groups and dataset access with the query capability)", params: s.memberParams,
    body: z.object({ templateId: s.id }).strict(),
    response: z.object({ templateId: s.id, role: z.enum(["VIEWER", "MEMBER", "BILLING_ADMIN", "ADMIN"]), datasets: z.number().int().nonnegative(), capabilityGranted: z.boolean() }),
    run: ({ user, params, body }) => accessTemplates.applyToMember(user.id, params.organizationId, params.userId, body.templateId),
  });
  const simulationResponse = z.object({
    user: z.object({ id: s.id, name: z.string().nullable(), email: z.string(), status: z.string() }),
    role: s.role, platformRole: z.string(),
    groups: z.array(z.object({ id: s.id, name: z.string() })),
    permissions: z.array(z.object({ permission: z.enum(permissions), origins: z.array(z.object({ type: z.enum(["ROLE", "GROUP", "DIRECT"]), id: s.id.optional(), name: z.string().optional() })) })),
    data: z.object({
      canQuery: z.boolean(), canManage: z.boolean(), truncated: z.boolean(),
      datasets: z.array(z.object({ id: s.id, name: z.record(z.string(), z.string()), slug: z.string(), status: z.string(), canQuery: z.boolean(), reason: z.enum(["OK", "ARCHIVED", "NO_QUERY_CAPABILITY", "ACL_DENIED"]) })),
    }),
    views: z.object({
      truncated: z.boolean(),
      panels: z.array(z.object({ id: s.id, name: z.record(z.string(), z.string()), slug: z.string(), visible: z.boolean(), reason: z.enum(["OK", "NO_READ_PERMISSION", "AUDIENCE_DENIED", "UNSUPPORTED_POLICY"]) })),
    }),
    notes: z.object({ platformPrivileges: z.string().nullable() }),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/members/:userId/access-simulation", tag: "Authorization",
    summary: "Read-only simulation of what a member can do and see (permissions with origin, dataset gates, published views); never impersonates", params: s.memberParams,
    response: simulationResponse,
    run: ({ user, params }) => accessSimulation.simulate(user.id, params.organizationId, params.userId),
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
    summary: "Grant a registered permission directly to a member, optionally for a number of days",
    params: s.memberParams,
    body: directPermissionBody,
    response: permissionGrant,
    status: 201,
    run: ({ user, params, body }) =>
      authorizationGroups.grantDirect(
        user.id,
        params.organizationId,
        params.userId,
        body.permission,
        body.days ? new Date(Date.now() + body.days * 86_400_000) : null,
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
    url: "/invitations/validate",
    tag: "Multi-tenancy",
    summary: "Check an invitation credential before sign-up and show the organization it belongs to",
    public: true,
    body: z.object({ token: z.string().trim().min(8).max(128) }).strict(),
    response: z.object({
      organization: z.object({ name: z.string(), slug: z.string(), iconData: z.string().nullable() }),
      kind: s.invitationKind,
      expiresAt: s.date,
      email: z.string().nullable(),
      accountExists: z.boolean().nullable(),
    }),
    rateLimit: 10,
    run: ({ body }) => invitations.validate(body.token),
  });
  contract(app, {
    method: "POST",
    url: "/invitations/accept-new",
    tag: "Multi-tenancy",
    summary: "Create the account of an emailed invitation's recipient (name and password) and accept it; no email verification is needed",
    public: true,
    body: z.object({ token: z.string().trim().min(8).max(128), name: z.string().trim().min(2).max(120), password: z.string().min(12).max(128) }).strict(),
    response: z.object({ email: z.string(), organization: z.object({ name: z.string(), slug: z.string() }) }),
    status: 201,
    rateLimit: 5,
    run: ({ body }) => invitations.acceptNew(body.token, { name: body.name, password: body.password }),
  });
  contract(app, {
    method: "POST",
    url: "/organizations/:organizationId/members/new",
    tag: "Multi-tenancy",
    summary: "Create a member account (name, address name@<org>.bp assigned automatically, typed or generated password)",
    params: s.orgParams,
    body: z.object({
      name: z.string().trim().min(2).max(120),
      localPart: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/).optional(),
      password: z.string().min(12).max(128).optional(),
      role: z.enum(["ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"]).optional(),
      groupIds: z.array(s.id).max(50).optional(),
      templateId: s.id.optional(),
      primaryGroupId: s.id.optional(),
    }).strict(),
    response: z.object({ membership: s.member, user: z.object({ id: s.id, email: z.string(), name: z.string() }), password: z.string().nullable() }),
    status: 201,
    rateLimit: 20,
    run: ({ user, params, body }) => invitations.createMember(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "GET",
    url: "/organizations/:organizationId/user-lookup",
    tag: "Multi-tenancy",
    summary: "Check whether an account exists for an email (members.manage)",
    params: s.orgParams,
    query: z.object({ email: z.string().trim().email().max(254) }).strict(),
    response: z.object({
      exists: z.boolean(),
      user: z.object({ id: s.id, email: z.string(), name: z.string().nullable(), emailVerified: z.boolean() }).nullable(),
      alreadyMember: z.boolean(),
    }),
    rateLimit: 30,
    run: ({ user, params, query }) => invitations.lookupUser(user.id, params.organizationId, query.email),
  });
  contract(app, {
    method: "POST",
    url: "/organizations/:organizationId/members",
    tag: "Multi-tenancy",
    summary: "Add an existing verified account to the organization",
    params: s.orgParams,
    body: z.object({
      email: z.string().trim().email().max(254),
      role: z.enum(["ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"]).optional(),
      groupIds: z.array(s.id).max(50).optional(),
      templateId: s.id.optional(),
      primaryGroupId: s.id.optional(),
    }).strict(),
    response: s.member,
    status: 201,
    rateLimit: 30,
    run: ({ user, params, body }) => invitations.addExistingMember(user.id, params.organizationId, body),
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
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/policy", tag: "Multi-tenancy",
    summary: "Read the organization's defaults for new accounts and its import-history retention", params: s.orgParams,
    response: orgPolicy,
    run: ({ user, params }) => organizationPolicy.get(user.id, params.organizationId),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/policy", tag: "Multi-tenancy",
    summary: "Set the default role and groups for new accounts and the import-history retention (needs organization.update and permissions.manage)", params: s.orgParams,
    body: orgPolicy.strict(), response: orgPolicy,
    run: ({ user, params, body }) => organizationPolicy.set(user.id, params.organizationId, body),
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
}
