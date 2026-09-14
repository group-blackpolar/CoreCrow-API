import { auditRepository } from "./repository.js";
import { requireOperator } from "../identity/service.js";
import { transaction } from "../../shared/transaction.js";
export async function operatorLogs(actorId, query) {
    await requireOperator(actorId);
    return transaction(async (tx) => {
        const logs = await auditRepository.globalList(tx, query);
        await auditRepository.append(tx, {
            actorId,
            action: "logs.view",
            targetType: "AuditLog",
        });
        return {
            logs,
            nextCursor: logs.length === query.limit ? logs.at(-1).id : null,
        };
    });
}
