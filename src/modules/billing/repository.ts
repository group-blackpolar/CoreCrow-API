import type { BillingStatus } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";

export const billingRepository = {
  profile(tx: Transaction, organizationId: string) {
    return tx.organizationBillingProfile.findUnique({
      where: { organizationId },
      include: { organization: { select: { status: true } } },
    });
  },
  billableMembers(tx: Transaction, organizationId: string) {
    return tx.membership.count({
      where: { organizationId, user: { status: "ACTIVE" } },
    });
  },
  updateEmail(
    tx: Transaction,
    organizationId: string,
    billingEmail: string | null,
  ) {
    return tx.organizationBillingProfile.update({
      where: { organizationId },
      data: { billingEmail },
    });
  },
  updateStatus(
    tx: Transaction,
    organizationId: string,
    status: BillingStatus,
  ) {
    return tx.organizationBillingProfile.update({
      where: { organizationId },
      data: { status },
    });
  },
  statusCounts(tx: Transaction) {
    return tx.organizationBillingProfile.groupBy({
      by: ["status"],
      _count: { _all: true },
      orderBy: { status: "asc" },
    });
  },
  eligibleProfileCount(tx: Transaction) {
    return tx.organizationBillingProfile.count({
      where: {
        status: { not: "CLOSED" },
        organization: { status: "ACTIVE" },
      },
    });
  },
  totalBillableMembers(tx: Transaction) {
    return tx.membership.count({
      where: {
        user: { status: "ACTIVE" },
        organization: {
          status: "ACTIVE",
          billingProfile: { status: { not: "CLOSED" } },
        },
      },
    });
  },
};
