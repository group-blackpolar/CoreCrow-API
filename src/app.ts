import Fastify, {
  type FastifyError,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import staticPlugin from "@fastify/static";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { auth, trustedOrigins } from "./lib/auth.js";
import { webHeaders } from "./shared/headers.js";
import { DomainError } from "./shared/errors.js";
import { ZodError } from "zod";
import { Prisma } from "./lib/database.js";
import { v1Routes } from "./routes/v1.js";
import { userRoutes } from "./routes/users.js";
import { adminSignInRoutes, authAdminRoutes, legacyMigrationRoute } from "./routes/auth-admin.js";
import { adminKeysRoutes } from "./routes/admin-keys.js";
import { adminLogsRoutes } from "./routes/admin-logs.js";
import { healthService } from "./modules/health/service.js";
import { healthPage } from "./modules/health/page.js";
import { auditRepository } from "./modules/audit/repository.js";
import { prisma } from "./lib/database.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  health as healthSchema,
  statusSummary as statusSummarySchema,
  statusSummaryQuery,
} from "./contracts/schemas.js";
import { RequestTelemetry } from "./modules/telemetry/service.js";
import { desktopAuthRoutes } from "./routes/desktop-auth.js";

export async function buildApp(
  options: {
    logger?: boolean;
    health?: ReturnType<typeof healthService>;
    telemetry?: RequestTelemetry;
  } = {},
) {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.NODE_ENV === "production" ? "warn" : "info",
            serializers: {
              req: (req: { method: string; url: string }) => ({
                method: req.method,
                path: req.url.split("?")[0],
              }),
              res: (reply: { statusCode: number }) => ({
                statusCode: reply.statusCode,
              }),
            },
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers.x-bootstrap-secret",
              "res.headers.set-cookie",
            ],
          },
    bodyLimit: 32768,
    ajv: { customOptions: { removeAdditional: false } },
    trustProxy:
      process.env.TRUST_PROXY === "loopback"
        ? "loopback"
        : process.env.TRUST_PROXY && isIP(process.env.TRUST_PROXY)
          ? process.env.TRUST_PROXY
          : false,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(cors, {
    origin: trustedOrigins,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "CORECROW API",
        version: "1.0.0",
        description:
          "Black Polar shared backend. Cookie identity, tenant membership authorization, audited contract commerce. /api aliases are deprecated.",
      },
      servers: [{ url: "https://api.blackpolar.org" }],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "__Secure-better-auth.session_token",
            description:
              "Better Auth cookie; development uses better-auth.session_token.",
          },
        },
      },
    },
  });
  await app.register(staticPlugin, {
    root: fileURLToPath(new URL("./public", import.meta.url)),
    prefix: "/",
    wildcard: false,
  });
  const telemetry = options.telemetry ?? new RequestTelemetry();
  const requestStartedAt = new Map<string, bigint>();
  app.addHook("onRequest", async (req) => {
    requestStartedAt.set(req.id, process.hrtime.bigint());
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (
      (origin && !trustedOrigins.includes(origin)) ||
      (!origin && req.headers["sec-fetch-site"] === "cross-site")
    )
      return reply.code(403).send({
        error: {
          code: "ORIGIN_DENIED",
          message: "Origin not allowed",
          requestId: req.id,
        },
      });
    if (req.headers.cookie && !origin)
      return reply.code(403).send({
        error: {
          code: "ORIGIN_REQUIRED",
          message: "Cookie writes require an Origin header",
          requestId: req.id,
        },
      });
  });
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "The request could not be completed";
    if (error instanceof DomainError) {
      status = error.statusCode;
      code = error.code;
      message = error.message;
    } else if (error instanceof ZodError || error.validation) {
      status = 400;
      code = "VALIDATION_ERROR";
      message = "Invalid request";
    } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        status = 409;
        code = "CONFLICT";
        message = "Resource already exists";
      }
      if (error.code === "P2025") {
        status = 404;
        code = "NOT_FOUND";
        message = "Resource not found";
      }
      if (error.code === "P2003") {
        status = 409;
        code = "REFERENCE_CONFLICT";
        message = "Related resource prevents this operation";
      }
    } else if (
      error.statusCode &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      code = status === 429 ? "RATE_LIMITED" : "INVALID_REQUEST";
      message = status === 429 ? "Too many requests" : "Invalid request";
    }
    if (status >= 500)
      req.log.error({ requestId: req.id, code }, "Request failed");
    return reply
      .code(status)
      .send({ error: { code, message, requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: req.id,
      },
    }),
  );
  app.addHook("onResponse", async (req, reply) => {
    if (![401, 403, 429].includes(reply.statusCode)) return;
    try {
      await auditRepository.append(prisma, {
        actorId: req.user?.id,
        action: `security.request.denied.${reply.statusCode}`,
        targetType: "HttpRequest",
        targetId: req.id,
      });
    } catch {
      req.log.error(
        { requestId: req.id },
        "Security event could not be recorded",
      );
    }
  });
  app.addHook("onResponse", async (req, reply) => {
    const startedAt = requestStartedAt.get(req.id);
    requestStartedAt.delete(req.id);
    if (startedAt === undefined) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    telemetry.record(durationMs, reply.statusCode);
  });
  const health = options.health ?? healthService();
  app.get("/", async (_, reply) =>
    reply
      .type("text/html")
      .send(healthPage(await health(), telemetry.summary("24h"))),
  );
  app.get("/health", async (_, reply) =>
    reply
      .type("text/html")
      .send(healthPage(await health(), telemetry.summary("24h"))),
  );
  const healthResponse = zodToJsonSchema(healthSchema, { target: "openApi3" });
  app.get(
    "/v1/health",
    {
      schema: {
        tags: ["Health"],
        summary: "Dependency readiness and process uptime",
        response: { 200: healthResponse, 503: healthResponse },
      },
    },
    async (_, reply) => {
      const state = await health();
      return reply.code(state.status === "operational" ? 200 : 503).send(state);
    },
  );
  app.get(
    "/v1/status/summary",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Health"],
        summary:
          "Sanitized aggregate process traffic for the public status page",
        querystring: zodToJsonSchema(statusSummaryQuery, {
          target: "openApi3",
        }),
        response: {
          200: zodToJsonSchema(statusSummarySchema, { target: "openApi3" }),
        },
      },
    },
    async (request) => {
      const query = statusSummaryQuery.parse(request.query);
      return telemetry.summary(query.window);
    },
  );
  app.get(
    "/v1/live",
    {
      schema: {
        tags: ["Health"],
        summary: "Process liveness (no dependency check)",
        response: {
          200: {
            type: "object",
            required: ["status", "apiVersion"],
            properties: {
              status: { const: "alive" },
              apiVersion: { const: "v1" },
            },
          },
        },
      },
    },
    async () => ({ status: "alive", apiVersion: "v1" }),
  );
  app.get("/v1/openapi.json", async () => app.swagger());
  const authHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    let requestPath = request.url.replace(/^\/api\/auth/, "/v1/auth");
    // Keep the Google Cloud callback already provisioned for Black Polar while
    // routing it through Better Auth's canonical provider callback internally.
    requestPath = requestPath.replace(
      /^\/v1\/auth\/oauth\/google\/callback(?=\?|$)/,
      "/v1/auth/callback/google",
    );
    const mailRequired = [
      "/v1/auth/sign-up/email",
      "/v1/auth/request-password-reset",
      "/v1/auth/send-verification-email",
    ].includes(requestPath.split("?")[0]!);
    if (
      request.method === "POST" &&
      mailRequired &&
      (!process.env.SMTP_URL || !process.env.MAIL_FROM)
    ) {
      return reply
        .code(503)
        .send({
          error: {
            code: "EMAIL_DELIVERY_UNAVAILABLE",
            message: "Account email delivery is not configured",
            requestId: request.id,
          },
        });
    }
    const headers = webHeaders(request.headers);
    // Derive the auth limiter address only from Fastify's configured proxy trust.
    headers.set("x-forwarded-for", request.ip);
    headers.set("x-real-ip", request.ip);
    const response = await auth.handler(
      new Request(
        new URL(
          requestPath,
          process.env.BETTER_AUTH_URL ?? "http://localhost:4000",
        ),
        {
          method: request.method,
          headers,
          ...(request.method !== "GET" && request.method !== "HEAD"
            ? { body: JSON.stringify(request.body) }
            : {}),
        },
      ),
    );
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") reply.header(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header("set-cookie", cookies);
    return reply.send(await response.text());
  };
  app.all("/v1/auth/*", authHandler);
  app.all("/api/auth/*", authHandler);
  await app.register(desktopAuthRoutes, { prefix: "/v1/desktop-auth" });
  await app.register(v1Routes, { prefix: "/v1" });
  await app.register(legacyMigrationRoute);
  await app.register(adminSignInRoutes);
  await app.register(
    async (legacy) => {
      legacy.addHook("onRequest", async (_, reply) => {
        reply.header("Deprecation", "true");
        reply.header("Link", '</v1/openapi.json>; rel="successor-version"');
      });
      await legacy.register(userRoutes);
      await legacy.register(adminKeysRoutes);
      await legacy.register(adminLogsRoutes);
      await legacy.register(authAdminRoutes);
    },
    { prefix: "/api" },
  );
  return app;
}
