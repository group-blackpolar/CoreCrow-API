import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fail } from "../shared/errors.js";
import { authenticateAdminSecret } from "../modules/identity/admin-secret-service.js";
import { error, user as userSchema } from "../contracts/schemas.js";

export async function adminSignInRoutes(app: FastifyInstance) {
  const input = z.object({
    email: z.string().email().max(254),
    secret: z.string().min(12).max(256),
  }).strict();
  const response = z.object({ user: userSchema });
  app.post("/v1/admin/sign-in", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: {
      tags: ["Identity"],
      summary: "Sign in an operator with a permanent admin secret",
      security: [],
      body: zodToJsonSchema(input, { target: "openApi3" }),
      response: {
        200: zodToJsonSchema(response, { target: "openApi3" }),
        "4xx": zodToJsonSchema(error, { target: "openApi3" }),
      },
    },
  }, async (req, reply) => {
    const data = input.parse(req.body);
    const authenticated = await authenticateAdminSecret(data.email, data.secret, req.ip);
    if (!authenticated) fail(401, "UNAUTHENTICATED", "Invalid credentials");
    const { user, signedSessionToken, sessionCookie } = authenticated;
    const { sameSite, ...cookieAttributes } = sessionCookie.attributes;
    const normalizedSameSite = typeof sameSite === "string"
      ? sameSite.toLowerCase() as "strict" | "lax" | "none"
      : sameSite;
    reply.setCookie(sessionCookie.name, signedSessionToken, {
      ...cookieAttributes,
      sameSite: normalizedSameSite,
    });
    return response.parse(JSON.parse(JSON.stringify({ user })));
  });
}
