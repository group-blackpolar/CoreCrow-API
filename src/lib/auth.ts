import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./database.js";
import { sendIdentityMail } from "../modules/security/mail.js";
import { issueEmailVerificationCode } from "../modules/identity/email-verification-service.js";
import { auditRepository } from "../modules/audit/repository.js";
import { openAPI } from "better-auth/plugins";
export const trustedOrigins = (
  process.env.TRUSTED_ORIGINS ?? "http://localhost:3000,http://localhost:3001"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
// PostgreSQL sessions are authoritative; no Redis or cookie cache delays revocation.
export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
    transaction: true,
  }),
  basePath: "/v1/auth",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:4000",
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins,
  plugins: [openAPI({ disableDefaultReference: true })],
  logger: { disabled: true },
  session: {
    expiresIn: 60 * 60 * 12,
    disableSessionRefresh: true,
    cookieCache: { enabled: false },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendIdentityMail(
        user.email,
        "Reset your Black Polar password",
        url,
      );
    },
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    // The Fastify adapter issues the code after Better Auth has committed the
    // new identity, avoiding an out-of-transaction lookup and duplicate mail.
    sendOnSignUp: false,
    sendVerificationEmail: async ({ user }) => {
      await issueEmailVerificationCode(user.email);
    },
  },
  socialProviders:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            redirectURI: process.env.GOOGLE_REDIRECT_URL,
          },
        }
      : {},
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "USER", input: false },
      status: { type: "string", defaultValue: "ACTIVE", input: false },
      passwordChangeRequired: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
      termsAcceptedAt: { type: "date", required: false, input: false },
      termsVersion: { type: "string", required: false, input: false },
    },
  },
  rateLimit: { enabled: true, window: 60, max: 30 },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await auditRepository.append(prisma, {
            actorId: user.id,
            action: "identity.register",
            targetId: user.id,
          });
        },
      },
      update: {
        after: async (user) => {
          await auditRepository.append(prisma, {
            actorId: user.id,
            action: "identity.update",
            targetId: user.id,
          });
        },
      },
    },
    account: {
      create: {
        after: async (account) => {
          await auditRepository.append(prisma, {
            actorId: account.userId,
            action: "identity.account.link",
            targetId: account.id,
          });
        },
      },
      delete: {
        after: async (account) => {
          await auditRepository.append(prisma, {
            actorId: account.userId,
            action: "identity.account.unlink",
            targetId: account.id,
          });
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          await auditRepository.append(prisma, {
            actorId: session.userId,
            action: "identity.session.create",
            targetId: session.id,
          });
        },
      },
      delete: {
        after: async (session) => {
          await auditRepository.append(prisma, {
            actorId: session.userId,
            action: "identity.session.revoke",
            targetId: session.id,
          });
        },
      },
    },
  },
});
export type Session = typeof auth.$Infer.Session;
