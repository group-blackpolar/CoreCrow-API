import type { FastifyRequest, FastifyReply } from "fastify";
import { principal } from "../modules/security/session.js";
import { requireOperator } from "../modules/identity/service.js";
import { legacyPrincipal } from "../modules/identity/legacy-service.js";
export async function authenticateAdmin(
  req: FastifyRequest,
  _reply: FastifyReply,
) {
  const bearer = req.headers.authorization;
  const user = bearer && /^Bearer [a-f0-9]{64}$/.test(bearer) ? await legacyPrincipal(bearer.slice(7)) : await principal(req);
  await requireOperator(user.id);
  req.admin = { id: user.id, role: user.role };
  req.user = { id: user.id, role: user.role };
}
