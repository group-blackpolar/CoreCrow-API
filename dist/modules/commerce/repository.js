import { prisma } from "../../lib/database.js";
export const commerceRepository = {
    catalog() {
        return prisma.product.findMany({
            where: { active: true },
            include: { plans: { where: { active: true } } },
            orderBy: { code: "asc" },
            take: 100,
        });
    },
    product(tx, data) {
        return tx.product.create({ data });
    },
    plan(tx, data) {
        return tx.plan.create({ data });
    },
    findPlan(tx, id) {
        return tx.plan.findUnique({ where: { id }, include: { product: true } });
    },
    replay(tx, idempotencyKey) {
        return tx.subscription.findUnique({
            where: { idempotencyKey },
            include: { invoices: true, entitlements: true },
        });
    },
    find(tx, id, organizationId) {
        return tx.subscription.findFirst({
            where: { id, organizationId },
            include: { entitlements: true },
        });
    },
    provision(tx, data, plan) {
        return tx.subscription.create({
            data: {
                ...data,
                invoices: {
                    create: { amountMinor: plan.priceMinor, currency: plan.currency },
                },
                entitlements: {
                    create: plan.features.map((feature) => ({
                        organizationId: data.organizationId,
                        productCode: plan.product.code,
                        feature,
                        expiresAt: data.endsAt,
                    })),
                },
            },
            include: { invoices: true, entitlements: true },
        });
    },
    async cancel(tx, id) {
        await tx.entitlement.updateMany({
            where: { subscriptionId: id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        return tx.subscription.update({
            where: { id },
            data: { status: "canceled" },
        });
    },
    list(tx, organizationId) {
        return tx.subscription.findMany({
            where: { organizationId },
            include: { invoices: true },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
    },
    entitlements(tx, organizationId) {
        return tx.entitlement.findMany({
            where: {
                organizationId,
                revokedAt: null,
                expiresAt: { gt: new Date() },
                subscription: { status: "active" },
            },
            take: 100,
        });
    },
};
