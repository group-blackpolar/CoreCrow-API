import { dependencyChecks } from "./repository.js";
import { verifyIdentityMailTransport } from "../security/mail.js";
export function healthService(check = dependencyChecks, checkMail = verifyIdentityMailTransport) {
    const startedAt = Date.now();
    let cache;
    let pending;
    return async () => {
        if (!cache || Date.now() - cache.at > 15000) {
            pending ??= Promise.all([check(), checkMail()]).then(([modules, emailDelivery]) => ({ modules, emailDelivery }));
            try {
                cache = { at: Date.now(), ...(await pending) };
            }
            finally {
                pending = undefined;
            }
        }
        return {
            status: cache.modules.every((m) => m.status === "available") &&
                cache.emailDelivery === "available"
                ? "operational"
                : "degraded",
            apiVersion: "v1",
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            checkedAt: new Date(cache.at).toISOString(),
            modules: cache.modules,
            emailDelivery: cache.emailDelivery === "not_configured"
                ? "not_configured"
                : "configured",
            emailTransport: cache.emailDelivery,
            commerceMode: "contract_provisioning",
        };
    };
}
