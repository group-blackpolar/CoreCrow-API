import crypto from 'crypto';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/database.js';
function hashToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}
export async function authenticate(req, reply) {
    const authHeader = req.headers.authorization;
    // Caso 1: token de servicio (Bearer)
    if (authHeader?.startsWith('Bearer ')) {
        const rawToken = authHeader.slice(7);
        const tokenHash = hashToken(rawToken);
        const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: tokenHash } });
        if (!apiKey || apiKey.revokedAt || apiKey.expiresAt < new Date()) {
            return reply.code(401).send({ error: 'Token inválido o expirado' });
        }
        // no bloqueante: actualiza lastUsed sin esperar
        prisma.apiKey.update({
            where: { id: apiKey.id },
            data: { lastUsed: new Date() },
        }).catch(() => { });
        req.apiKey = { id: apiKey.id, scopes: apiKey.scopes };
        return;
    }
    // Caso 2: sesión de usuario (cookie de Better Auth, ya cacheada en Redis si configuraste secondary storage)
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
        return reply.code(401).send({ error: 'No autenticado' });
    }
    req.user = { id: session.user.id, role: session.user.role };
}
