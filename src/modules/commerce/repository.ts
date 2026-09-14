import { prisma } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
export const commerceRepository = {
  catalog() {
    return prisma.product.findMany({
      where: { active: true },
      include: { plans: { where: { active: true } } },
      orderBy: { code: "asc" },
      take: 100,
    });
  },
  product(tx: Transaction, data: { code: string; name: string }) {
    return tx.product.create({ data });
  },
  plan(
    tx: Transaction,
    data: {
      productId: string;
      code: string;
      name: string;
      priceMinor: number;
      currency: string;
      interval: string;
      features: string[];
    },
  ) {
    return tx.plan.create({ data });
  },
  findPlan(tx: Transaction, id: string) {
    return tx.plan.findUnique({ where: { id }, include: { product: true } });
  },
  replay(tx: Transaction, idempotencyKey: string) {
    return tx.subscription.findUnique({
      where: { idempotencyKey },
      include: { invoices: true, entitlements: true },
    });
  },
  find(tx: Transaction, id: string, organizationId: string) {
    return tx.subscription.findFirst({
      where: { id, organizationId },
      include: { entitlements: true },
    });
  },
  provision(
    tx: Transaction,
    data: {
      organizationId: string;
      planId: string;
      endsAt: Date;
      idempotencyKey: string;
      requestHash: string;
    },
    plan: {
      priceMinor: number;
      currency: string;
      features: string[];
      product: { code: string };
    },
  ) {
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
  async cancel(tx: Transaction, id: string) {
    await tx.entitlement.updateMany({
      where: { subscriptionId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return tx.subscription.update({
      where: { id },
      data: { status: "canceled" },
    });
  },
  list(tx: Transaction, organizationId: string) {
    return tx.subscription.findMany({
      where: { organizationId },
      include: { invoices: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  },
  entitlements(tx: Transaction, organizationId: string) {
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
