import { prisma } from "../../lib/database.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";

const ADVISORY_LOCK = 7_240_012; // one security retention sweep at a time across API instances
const BATCH = 5000;

/**
 * Applies each organization's `retentionDays` (default 90) to the policy's operational records: alerts, revoked devices and the
 * retention log itself. Never touches active devices (they are only ever revoked by a person), sessions or the audit log. An active,
 * authorized exception skips the organization. Each run is recorded (SecurityRetentionRun + audit) and idempotent.
 */
export async function runSecurityRetention(now = new Date()) {
  const policies = await prisma.organizationSecurityPolicy.findMany({ select: { organizationId: true, retentionDays: true, retentionExemptUntil: true } });
  let purged = 0;
  for (const policy of policies) {
    const done = await transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK}) AS locked`;
      if (!lock?.locked) return null;
      const cutoff = new Date(now.getTime() - policy.retentionDays * 86_400_000);
      if (policy.retentionExemptUntil && policy.retentionExemptUntil > now) {
        await tx.securityRetentionRun.create({ data: { organizationId: policy.organizationId, retentionDays: policy.retentionDays, skipped: "exception" } });
        return 0;
      }
      const alertIds = (await tx.securityAlert.findMany({ where: { organizationId: policy.organizationId, lastSeenAt: { lt: cutoff }, status: { not: "OPEN" } }, select: { id: true }, take: BATCH })).map((row) => row.id);
      const alerts = await tx.securityAlert.deleteMany({ where: { id: { in: alertIds } } });
      const deviceIds = (await tx.securityDevice.findMany({ where: { organizationId: policy.organizationId, revokedAt: { lt: cutoff } }, select: { id: true }, take: BATCH })).map((row) => row.id);
      const devices = await tx.securityDevice.deleteMany({ where: { id: { in: deviceIds } } });
      await tx.securityRetentionRun.deleteMany({ where: { organizationId: policy.organizationId, ranAt: { lt: cutoff } } });
      await tx.securityRetentionRun.create({ data: { organizationId: policy.organizationId, retentionDays: policy.retentionDays, purgedAlerts: alerts.count, purgedDevices: devices.count } });
      if (alerts.count || devices.count)
        await audit.append(tx, { organizationId: policy.organizationId, action: "security.retention.run", targetType: "organization", targetId: policy.organizationId, metadata: { retentionDays: policy.retentionDays, purgedAlerts: alerts.count, purgedDevices: devices.count } });
      return alerts.count + devices.count;
    });
    if (done === null) return purged; // another instance is sweeping
    purged += done;
  }
  return purged;
}

/** Hourly check, first run two minutes after boot. Disabled with SECURITY_RETENTION_ENABLED=false. Failures reach `onError`. */
export function startSecurityRetention(onError: (error: unknown) => void) {
  if (process.env.SECURITY_RETENTION_ENABLED === "false") return () => undefined;
  const tick = () => { runSecurityRetention().catch(onError); };
  const first = setTimeout(tick, 120_000);
  const timer = setInterval(tick, 3_600_000);
  return () => { clearTimeout(first); clearInterval(timer); };
}
