import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { auth } from "../lib/auth.js";
import { webHeaders } from "../shared/headers.js";
import { fail } from "../shared/errors.js";
import { desktopIdentity } from "../modules/identity/desktop-service.js";
import * as schemas from "../contracts/schemas.js";

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const exchangeBody = z
  .object({ code: hex64, verifier: hex64 })
  .strict();
const startQuery = z
  .object({ nonce: hex64, challenge: hex64, signup: z.enum(["0", "1"]).default("0") })
  .strict();
const callbackQuery = z.object({ nonce: hex64 }).strict();
const errorQuery = z
  .object({ nonce: hex64, error: z.string().max(80).optional() })
  .strict();

const DESKTOP_CALLBACK = "north://auth/callback";

function desktopToken(request: FastifyRequest) {
  const match = request.headers.authorization?.match(
    /^Bearer ([A-Za-z0-9._-]{20,256})$/,
  );
  if (!match || match[1]!.startsWith("bp_"))
    fail(401, "UNAUTHENTICATED", "Desktop session required");
  return match[1]!;
}

export async function desktopAuthRoutes(app: FastifyInstance) {
  app.get(
    "/google/start",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Identity"],
        summary: "Start Google authentication in the system browser for North desktop",
        querystring: zodToJsonSchema(startQuery, { target: "openApi3" }),
      },
    },
    async (request, reply) => {
      const query = startQuery.parse(request.query);
      await desktopIdentity.start(query.nonce, query.challenge);

      const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:4000";
      const completion = `${baseURL}/v1/desktop-auth/google/complete?nonce=${query.nonce}`;
      const failure = `${baseURL}/v1/desktop-auth/google/error?nonce=${query.nonce}`;
      const response = await auth.handler(
        new Request(`${baseURL}/v1/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "google",
            callbackURL: completion,
            errorCallbackURL: failure,
            requestSignUp: query.signup === "1",
            disableRedirect: true,
          }),
        }),
      );
      const body = await response.json().catch(() => null) as {
        url?: string;
        message?: string;
      } | null;
      if (!response.ok || !body?.url)
        fail(503, "GOOGLE_AUTH_UNAVAILABLE", "Google authentication is unavailable");
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.redirect(body.url);
    },
  );

  app.get(
    "/google/complete",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["Identity"],
        summary: "Finish browser authentication and return a one-time code to North",
        querystring: zodToJsonSchema(callbackQuery, { target: "openApi3" }),
      },
    },
    async (request, reply) => {
      const { nonce } = callbackQuery.parse(request.query);
      const pending = await desktopIdentity.pending(nonce);
      if (!pending || pending.expiresAt <= new Date())
        return reply.redirect(`${DESKTOP_CALLBACK}?error=expired_request`);
      const session = await auth.api.getSession({ headers: webHeaders(request.headers) });
      if (!session)
        return reply.redirect(`${DESKTOP_CALLBACK}?error=missing_session`);
      const code = await desktopIdentity.complete(
        pending,
        session.user.id,
        session.session.id,
      );
      return reply.redirect(`${DESKTOP_CALLBACK}?code=${code}`);
    },
  );

  app.get(
    "/google/error",
    {
      schema: {
        tags: ["Identity"],
        summary: "Return a sanitized OAuth error to North desktop",
        querystring: zodToJsonSchema(errorQuery, { target: "openApi3" }),
      },
    },
    async (request, reply) => {
      const query = errorQuery.parse(request.query);
      await desktopIdentity.cancel(query.nonce);
      const safeError = /^[a-z0-9_]{1,80}$/.test(query.error ?? "")
        ? query.error
        : "oauth_failed";
      return reply.redirect(`${DESKTOP_CALLBACK}?error=${safeError}`);
    },
  );

  app.post(
    "/exchange",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Identity"],
        summary: "Exchange a single-use desktop OAuth code using its PKCE verifier",
        body: zodToJsonSchema(exchangeBody, { target: "openApi3" }),
        response: {
          200: zodToJsonSchema(
            z.object({ token: z.string(), user: schemas.user }),
            { target: "openApi3" },
          ),
        },
      },
    },
    async (request) => {
      const { code, verifier } = exchangeBody.parse(request.body);
      return desktopIdentity.exchange(code, verifier);
    },
  );

  app.delete(
    "/session",
    {
      schema: {
        tags: ["Identity"],
        summary: "Revoke the current North desktop session",
        response: { 204: { type: "null" } },
      },
    },
    async (request, reply) => {
      const token = desktopToken(request);
      await desktopIdentity.revoke(token);
      return reply.code(204).send();
    },
  );
}
