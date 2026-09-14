import type { FastifyRequest, FastifyReply } from "fastify";
import { principal } from "../modules/security/session.js";
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const user = await principal(req);
  req.user = { id: user.id, role: user.role };
}
