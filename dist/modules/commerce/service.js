import { commerceRepository as repo } from "./repository.js";
import { requireOperator } from "../identity/service.js";
import { tenantRepository } from "../tenancy/repository.js";
import { authorize } from "../authorization/service.js";
import { auditRepository as audit } from "../audit/repository.js";
import { hash } from "../security/crypto.js";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
export const commerce = {
    catalog: repo.catalog,
    async product(actorId, data) {
        await requireOperator(actorId, true);
        return transaction(async (tx) => {
            const result = await repo.product(tx, data);
            await audit.append(tx, {
                actorId,
                action: "commerce.product.create",
                targetId: result.id,
            });
            return result;
        });
    },
    async plan(actorId, data) {
        await requireOperator(actorId, true);
        return transaction(async (tx) => {
            const result = await repo.plan(tx, data);
            await audit.append(tx, {
                actorId,
                action: "commerce.plan.create",
                targetId: result.id,
            });
            return result;
        });
    },
    async provision(actorId, data, idempotencyKey) {
        await requireOperator(actorId, true);
        const requestHash = hash(JSON.stringify([data.organizationId, data.planId, data.endsAt]));
        return transaction(async (tx) => {
            const replay = await repo.replay(tx, idempotencyKey);
            if (replay) {
                if (replay.requestHash !== requestHash)
                    fail(409, "IDEMPOTENCY_CONFLICT", "Key already used for a different request");
                return replay;
            }
            if (!(await tenantRepository.organization(tx, data.organizationId)))
                fail(404, "NOT_FOUND", "Organization not found");
            const plan = await repo.findPlan(tx, data.planId);
            if (!plan?.active || !plan.product.active)
                fail(404, "NOT_FOUND", "Plan not available");
            if (new Date(data.endsAt) <= new Date())
                fail(400, "INVALID_PERIOD", "End date must be in the future");
            const result = await repo.provision(tx, { ...data, endsAt: new Date(data.endsAt), idempotencyKey, requestHash }, plan);
            await audit.append(tx, {
                actorId,
                organizationId: data.organizationId,
                action: "commerce.contract.provision",
                targetId: result.id,
            });
            return result;
        });
    },
    async cancel(actorId, organizationId, id) {
        await requireOperator(actorId, true);
        return transaction(async (tx) => {
            const subscription = await repo.find(tx, id, organizationId);
            if (!subscription)
                fail(404, "NOT_FOUND", "Subscription not found");
            if (subscription.status === "canceled")
                return subscription;
            const result = await repo.cancel(tx, id);
            await audit.append(tx, {
                actorId,
                organizationId,
                action: "commerce.subscription.cancel",
                targetId: id,
            });
            return result;
        });
    },
    list(actorId, organizationId) {
        return transaction(async (tx) => {
            await authorize(tx, actorId, organizationId, "commerce.read");
            return repo.list(tx, organizationId);
        });
    },
    entitlements(actorId, organizationId) {
        return transaction(async (tx) => {
            await authorize(tx, actorId, organizationId, "commerce.read");
            return repo.entitlements(tx, organizationId);
        });
    },
};
