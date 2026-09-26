import { auditRepository } from "./repository.js";
import { requireOperator } from "../identity/service.js";
import { transaction } from "../../shared/transaction.js";

export type OperatorLogQuery = {
  limit: number;
  cursor?: string;
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
};

/** Global platform audit listing.
 *
 * Superadmin-only by decision: audit records span every tenant, so a delegated
 * platform ADMIN must not read them. Tenant-scoped audit remains available
 * through `GET /v1/organizations/{organizationId}/audit` with `audit.read` or
 * `north.audit.read`. Every read is itself audited as `logs.view`. */
export async function operatorLogs(actorId: string, query: OperatorLogQuery) {
  await requireOperator(actorId, true);
  return transaction(async (tx) => {
    const rows = await auditRepository.globalList(tx, query);
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    await auditRepository.append(tx, {
      actorId,
      action: "logs.view",
      targetType: "AuditLog",
    });
    return {
      items,
      nextCursor: hasMore ? items.at(-1)!.id : null,
    };
  });
}
