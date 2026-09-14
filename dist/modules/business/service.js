import { contacts } from "./repository.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { requireOperator } from "../identity/service.js";
export async function createContact(data) {
    return transaction(async (tx) => {
        const result = await contacts.create(tx, data);
        await auditRepository.append(tx, {
            action: "contact.create",
            targetType: "ContactRequest",
            targetId: result.id,
        });
        return result;
    });
}
export async function listContacts(actorId, limit) {
    await requireOperator(actorId);
    return transaction(async (tx) => {
        const result = await contacts.list(tx, limit);
        await auditRepository.append(tx, {
            actorId,
            action: "contact.list",
            targetType: "ContactRequest",
        });
        return result;
    });
}
