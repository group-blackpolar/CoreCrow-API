import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { error } from "./schemas.js";
import { principal } from "../modules/security/session.js";
import { DomainError } from "../shared/errors.js";
const json = (schema: z.ZodTypeAny) =>
  zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
export function contract<
  B extends z.ZodTypeAny = z.ZodUndefined,
  P extends z.ZodTypeAny = z.ZodUndefined,
  Q extends z.ZodTypeAny = z.ZodUndefined,
>(
  app: FastifyInstance,
  options: {
    method: HTTPMethods;
    url: string;
    tag: string;
    summary: string;
    body?: B;
    params?: P;
    query?: Q;
    response: z.ZodTypeAny;
    status?: number;
    public?: boolean;
    rateLimit?: number;
    idempotency?: boolean;
    run: (input: {
      body: z.infer<B>;
      params: z.infer<P>;
      query: z.infer<Q>;
      user: Awaited<ReturnType<typeof principal>>;
      request: FastifyRequest;
    }) => Promise<unknown>;
  },
) {
  app.route({
    method: options.method,
    url: options.url,
    config: options.rateLimit
      ? { rateLimit: { max: options.rateLimit, timeWindow: "1 minute" } }
      : {},
    schema: {
      tags: [options.tag],
      summary: options.summary,
      security: options.public ? [] : [{ sessionCookie: [] }],
      ...(options.idempotency
        ? {
            headers: {
              type: "object",
              required: ["idempotency-key"],
              properties: {
                "idempotency-key": {
                  type: "string",
                  pattern: "^[A-Za-z0-9_-]{16,128}$",
                },
              },
            },
          }
        : {}),
      ...(options.body ? { body: json(options.body) } : {}),
      ...(options.params ? { params: json(options.params) } : {}),
      ...(options.query ? { querystring: json(options.query) } : {}),
      response: {
        [options.status ?? 200]: json(options.response),
        "4xx": json(error),
        "5xx": json(error),
      },
    },
    handler: async (request, reply) => {
      const user = options.public ? undefined : await principal(request);
      const value = await options.run({
        body: options.body?.parse(request.body),
        params: options.params?.parse(request.params),
        query: options.query?.parse(request.query),
        user: user!,
        request,
      });
      // Project responses to the contract; never expose internal hashes or persistence fields.
      const parsed = options.response.safeParse(
        JSON.parse(JSON.stringify(value ?? null)),
      );
      if (!parsed.success)
        throw new DomainError(
          500,
          "RESPONSE_CONTRACT_ERROR",
          "The response could not be completed",
        );
      const output = parsed.data;
      return reply.code(options.status ?? 200).send(output);
    },
  });
}
