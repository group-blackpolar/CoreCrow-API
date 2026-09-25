import { zodToJsonSchema } from "zod-to-json-schema";
import { error } from "./schemas.js";
import { principal } from "../modules/security/session.js";
import { DomainError } from "../shared/errors.js";
import { withRequestContext } from "../shared/request-context.js";
const json = (schema) => zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
export function contract(app, options) {
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
            ...(options.idempotency || options.headers
                ? {
                    headers: {
                        type: "object",
                        required: [
                            ...(options.idempotency ? ["idempotency-key"] : []),
                            ...(options.headers?.required ?? []),
                        ],
                        properties: {
                            ...(options.idempotency ? { "idempotency-key": {
                                    type: "string",
                                    pattern: "^[A-Za-z0-9_-]{16,128}$",
                                } } : {}),
                            ...(options.headers?.properties ?? {}),
                        },
                        additionalProperties: true,
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
            return withRequestContext(request.id, async () => {
                const user = options.public ? undefined : await principal(request);
                const value = await options.run({
                    body: options.body?.parse(request.body),
                    params: options.params?.parse(request.params),
                    query: options.query?.parse(request.query),
                    user: user,
                    request,
                    reply,
                });
                // Project responses to the contract; never expose internal hashes or persistence fields.
                const parsed = options.response.safeParse(JSON.parse(JSON.stringify(value ?? null, (_key, item) => typeof item === "bigint" ? Number(item) : item)));
                if (!parsed.success)
                    throw new DomainError(500, "RESPONSE_CONTRACT_ERROR", "The response could not be completed");
                return reply.code(options.status ?? 200).send(parsed.data);
            });
        },
    });
}
