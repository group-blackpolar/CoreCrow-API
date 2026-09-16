import { auth } from "../../lib/auth.js";
import { identities } from "../identity/repository.js";
import { webHeaders } from "../../shared/headers.js";
import { fail } from "../../shared/errors.js";
import { keys } from "./repository.js";
import { hash } from "./crypto.js";
import { desktopIdentity } from "../identity/desktop-service.js";
export async function principal(request) {
    if (request.headers.authorization) {
        const token = request.headers.authorization;
        const bearer = token.match(/^Bearer ([A-Za-z0-9._-]{20,256})$/);
        if (bearer && !bearer[1].startsWith("bp_")) {
            const user = await desktopIdentity.authenticate(bearer[1]);
            request.user = { id: user.id, role: user.role };
            return user;
        }
        if (!/^Bearer bp_[a-f0-9]{64}$/.test(token))
            fail(401, "UNAUTHENTICATED", "Invalid bearer credential");
        const key = await keys.find(hash(token.slice(7)));
        if (!key || key.revokedAt || key.expiresAt <= new Date())
            fail(401, "UNAUTHENTICATED", "Invalid API key");
        const path = request.url.split("?")[0] ?? "";
        const scope = /^\/v1\/organizations(?:\/[^/]+)?$/.test(path)
            ? "organizations:read"
            : /^\/v1\/organizations\/[^/]+\/(subscriptions|entitlements)$/.test(path)
                ? "commerce:read"
                : undefined;
        if (request.method !== "GET" || !scope || !key.scopes.includes(scope))
            fail(403, "FORBIDDEN", "API key scope does not allow this operation");
        const user = await identities.get(key.userId);
        if (!user || !user.emailVerified)
            fail(401, "UNAUTHENTICATED", "Key owner unavailable");
        await keys.used(key.id);
        request.user = { id: user.id, role: user.role };
        return user;
    }
    const session = await auth.api.getSession({
        headers: webHeaders(request.headers),
    });
    if (!session)
        fail(401, "UNAUTHENTICATED", "A valid user session is required");
    const user = await identities.get(session.user.id);
    if (!user)
        fail(401, "UNAUTHENTICATED", "User unavailable");
    request.user = { id: user.id, role: user.role };
    return user;
}
