import { dependencyChecks } from "./repository.js";
export type HealthSnapshot = Awaited<
  ReturnType<ReturnType<typeof healthService>>
>;
export function healthService(check = dependencyChecks) {
  const startedAt = Date.now();
  let cache:
    { at: number; modules: Awaited<ReturnType<typeof check>> } | undefined;
  let pending: ReturnType<typeof check> | undefined;
  return async () => {
    if (!cache || Date.now() - cache.at > 15000) {
      pending ??= check();
      try {
        cache = { at: Date.now(), modules: await pending };
      } finally {
        pending = undefined;
      }
    }
    const emailConfigured = !!(process.env.SMTP_URL && process.env.MAIL_FROM);
    return {
      status:
        cache.modules.every((m) => m.status === "available") && emailConfigured
          ? "operational"
          : "degraded",
      apiVersion: "v1",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checkedAt: new Date(cache.at).toISOString(),
      modules: cache.modules,
      emailDelivery: emailConfigured ? "configured" : "not_configured",
      commerceMode: "contract_provisioning",
    };
  };
}
