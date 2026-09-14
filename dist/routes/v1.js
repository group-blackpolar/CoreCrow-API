import { z } from "zod";
import { contract } from "../contracts/route.js";
import * as s from "../contracts/schemas.js";
import { tenants } from "../modules/tenancy/service.js";
import { commerce } from "../modules/commerce/service.js";
import { identities } from "../modules/identity/repository.js";
import { users, requireOperator } from "../modules/identity/service.js";
import { permissions, allows } from "../modules/authorization/policy.js";
import { authorize } from "../modules/authorization/service.js";
import { transaction } from "../shared/transaction.js";
import { auditRepository } from "../modules/audit/repository.js";
import { createContact, listContacts } from "../modules/business/service.js";
import { fail } from "../shared/errors.js";
import { security, keyScopes } from "../modules/security/service.js";
export async function v1Routes(app) {
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
        method: "GET",
        url: "/security/keys",
        tag: "Security",
        summary: "List your API keys without secrets",
        response: z.array(key),
        run: ({ user }) => security.list(user.id),
    });
    contract(app, {
        method: "POST",
        url: "/security/keys",
        tag: "Security",
        summary: "Issue a read-only API key valid for seven days; membership remains authoritative",
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
                .min(2)
                .max(60)
                .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        })
            .strict(),
        response: s.org,
        status: 201,
        run: ({ user, body }) => tenants.create(user.id, body),
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
        summary: "Rename an organization",
        params: s.orgParams,
        body: z.object({ name: s.name }).strict(),
        response: s.org,
        run: ({ user, params, body }) => tenants.update(user.id, params.organizationId, body.name),
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
        method: "PATCH",
        url: "/organizations/:organizationId/members/:userId",
        tag: "Authorization",
        summary: "Change a tenant role; protect the last owner",
        params: s.memberParams,
        body: z.object({ role: s.role }).strict(),
        response: s.member,
        run: ({ user, params, body }) => tenants.changeMember(user.id, params.organizationId, params.userId, body.role),
    });
    contract(app, {
        method: "DELETE",
        url: "/organizations/:organizationId/members/:userId",
        tag: "Multi-tenancy",
        summary: "Remove a member; protect the last owner",
        params: s.memberParams,
        response: s.member,
        run: ({ user, params }) => tenants.changeMember(user.id, params.organizationId, params.userId),
    });
    contract(app, {
        method: "GET",
        url: "/organizations/:organizationId/permissions",
        tag: "Authorization",
        summary: "Resolve effective tenant permissions from membership",
        params: s.orgParams,
        response: z.object({
            role: s.role,
            permissions: z.array(z.enum(permissions)),
        }),
        run: ({ user, params }) => transaction(async (tx) => {
            const member = await authorize(tx, user.id, params.organizationId, "organization.read");
            return {
                role: member.role,
                permissions: permissions.filter((p) => allows(member.role, p)),
            };
        }),
    });
    contract(app, {
        method: "POST",
        url: "/organizations/:organizationId/invitations",
        tag: "Multi-tenancy",
        summary: "Issue an invitation; the token is returned once for secure sharing",
        params: s.orgParams,
        body: z
            .object({
            email: z.string().email().max(254),
            role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"),
        })
            .strict(),
        response: z.object({
            id: s.id,
            email: z.string(),
            role: s.role,
            expiresAt: s.date,
            token: z.string(),
        }),
        status: 201,
        run: ({ user, params, body }) => tenants.invite(user.id, params.organizationId, body.email, body.role),
    });
    contract(app, {
        method: "POST",
        url: "/invitations/accept",
        tag: "Multi-tenancy",
        summary: "Accept a single-use invitation with the verified recipient identity",
        body: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        response: s.member,
        run: ({ user, body }) => tenants.accept(user, body.token),
    });
    contract(app, {
        method: "DELETE",
        url: "/organizations/:organizationId/invitations/:id",
        tag: "Multi-tenancy",
        summary: "Revoke an invitation",
        params: s.orgParams.extend({ id: s.id }),
        response: z.null(),
        run: async ({ user, params }) => {
            await tenants.revoke(user.id, params.organizationId, params.id);
            return null;
        },
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
        run: ({ user, params, query }) => transaction(async (tx) => {
            await authorize(tx, user.id, params.organizationId, "audit.read");
            await auditRepository.append(tx, {
                actorId: user.id,
                organizationId: params.organizationId,
                action: "audit.read",
            });
            return auditRepository.list(params.organizationId, query.limit, query.before ? new Date(query.before) : undefined);
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
        summary: "Provision an approved contract; requires Idempotency-Key and superadmin; no payment collected",
        body: z
            .object({ organizationId: s.id, planId: s.id, endsAt: s.date })
            .strict(),
        response: s.subscription,
        status: 201,
        run: ({ user, body, request }) => {
            const key = request.headers["idempotency-key"];
            if (typeof key !== "string" || !/^[\w-]{16,128}$/.test(key))
                fail(400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a 16–128 character Idempotency-Key");
            return commerce.provision(user.id, body, key);
        },
    });
    contract(app, {
        method: "POST",
        url: "/commerce/organizations/:organizationId/subscriptions/:id/cancel",
        tag: "Commerce",
        summary: "Cancel a contract and revoke entitlements atomically (superadmin)",
        params: s.orgParams.extend({ id: s.id }),
        response: s.subscription,
        run: ({ user, params }) => commerce.cancel(user.id, params.organizationId, params.id),
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
        run: ({ user, params }) => commerce.entitlements(user.id, params.organizationId),
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
        response: z.array(s.contactInput
            .omit({ consent: true })
            .extend({ id: s.id, createdAt: s.date, consentAt: s.date })),
        run: ({ user, query }) => listContacts(user.id, query.limit),
    });
}
