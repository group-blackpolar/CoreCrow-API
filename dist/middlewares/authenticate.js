import { principal } from "../modules/security/session.js";
export async function authenticate(req, _reply) {
    const user = await principal(req);
    req.user = { id: user.id, role: user.role };
}
