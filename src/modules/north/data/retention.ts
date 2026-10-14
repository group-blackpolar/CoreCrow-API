import { prisma } from "../../../lib/database.js";
import { transaction } from "../../../shared/transaction.js";
import { deleteImportBlobs, purgeImportRecords } from "./service.js";

const ADVISORY_LOCK = 7_240_011; // one retention sweep at a time across API instances

/**
 * Applies each organization's `importRetentionDays` to its operational import history. Idempotent: a second run finds nothing
 * new. Bounded per organization and run (see IMPORT_PURGE_BATCH); a backlog drains over successive runs. Never touches
 * imports that produced data or the security audit log.
 */
export async function runImportRetention() {
  const policies = await prisma.organizationPolicy.findMany({ where: { importRetentionDays: { not: null } }, select: { organizationId: true, importRetentionDays: true } });
  let purged = 0;
  for (const policy of policies) {
    const result = await transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK}) AS locked`;
      if (!lock?.locked) return null;
      return purgeImportRecords(tx, { organizationId: policy.organizationId, olderThanDays: policy.importRetentionDays!, dryRun: false });
    });
    if (!result) return purged; // another instance is sweeping
    await deleteImportBlobs(result.storageKeys);
    purged += result.purged;
  }
  return purged;
}

/** Hourly check, first run one minute after boot. Disabled with NORTH_RETENTION_ENABLED=false. */
export function startImportRetention(onError: (error: unknown) => void) {
  if (process.env.NORTH_RETENTION_ENABLED === "false") return () => undefined;
  const tick = () => { runImportRetention().catch(onError); };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, 3_600_000);
  return () => { clearTimeout(first); clearInterval(timer); };
}
