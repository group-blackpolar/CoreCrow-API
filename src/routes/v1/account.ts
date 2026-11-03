import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../../contracts/route.js";
import * as s from "../../contracts/schemas.js";
import { identities } from "../../modules/identity/repository.js";
import { CURRENT_TERMS_VERSION, users, requireOperator } from "../../modules/identity/service.js";
import { createContact, listContacts } from "../../modules/business/service.js";
import { fail } from "../../shared/errors.js";
import { security, keyScopes } from "../../modules/security/service.js";
import { requirePersonalWorkspace } from "../../modules/identity/personal-workspace.js";
import { changeTemporaryPassword } from "../../modules/identity/temporary-password-service.js";
import { confirmEmailVerificationCode, requestEmailVerificationCode } from "../../modules/identity/email-verification-service.js";
import { userAvatars } from "../../modules/identity/avatar-service.js";

export async function accountRoutes(app: FastifyInstance) {
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
  const avatarView = z.object({ id: s.id, mime: z.string(), size: z.number().int(), status: s.northAssetStatus, confirmedAt: s.date.nullable(), createdAt: s.date });
  contract(app, {
    method: "POST", url: "/me/avatar/uploads", tag: "Identity",
    summary: "Request a checksum-bound signed upload for your own avatar (JPEG, PNG or WebP, at most 2 MiB)",
    body: z.object({ mime: z.string().trim().min(1).max(127), size: z.number().int().min(1), checksum: z.string().regex(/^[0-9a-fA-F]{64}$/) }).strict(),
    response: z.object({ avatar: avatarView, upload: s.northSignedObjectRequest }), status: 201,
    run: ({ user, body }) => userAvatars.requestUpload(user.id, body),
  });
  contract(app, {
    method: "POST", url: "/me/avatar/:avatarId/confirm", tag: "Identity",
    summary: "Inspect, scan and activate your uploaded avatar, replacing the previous one",
    params: z.object({ avatarId: s.id }).strict(), response: avatarView,
    run: ({ user, params }) => userAvatars.confirm(user.id, params.avatarId),
  });
  contract(app, {
    method: "GET", url: "/me/avatar", tag: "Identity",
    summary: "Signed read of your own avatar, or nulls when none is set",
    response: z.object({ avatar: avatarView.nullable(), download: s.northSignedObjectRequest.nullable() }),
    run: ({ user }) => userAvatars.readOwn(user.id),
  });
  contract(app, {
    method: "DELETE", url: "/me/avatar", tag: "Identity",
    summary: "Remove your own avatar", response: z.null(),
    run: ({ user }) => userAvatars.deleteOwn(user.id),
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
    run: ({ user }) => {
      requirePersonalWorkspace(user);
      return security.list(user.id);
    },
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
    run: ({ user, body }) => {
      requirePersonalWorkspace(user);
      return security.create(user.id, body);
    },
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
