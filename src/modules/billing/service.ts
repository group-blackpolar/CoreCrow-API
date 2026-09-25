import type { BillingStatus } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize } from "../authorization/service.js";
import { requireOperator } from "../identity/service.js";
import { billingRepository as repo } from "./repository.js";

const BASE_PRICE_MINOR = 1400;
const MEMBER_PRICE_MINOR = 500;

async function estimate(
  tx: Parameters<typeof repo.profile>[0],
  organizationId: string,
) {
  const profile = await repo.profile(tx, organizationId);
  if (!profile) fail(404, "BILLING_PROFILE_NOT_FOUND", "Billing profile not found");
  const { organization, ...publicProfile } = profile;
  const estimateEligible =
    organization.status === "ACTIVE" && profile.status !== "CLOSED";
  const billableMemberCount = estimateEligible
    ? await repo.billableMembers(tx, organizationId)
    : 0;
  return {
    ...publicProfile,
    billableMemberCount,
    groupsCostMinor: 0,
    estimatedMonthlyMinor:
      estimateEligible
        ? profile.basePriceMinor + billableMemberCount * profile.memberPriceMinor
        : 0,
  };
}

export const billing = {
  async platformRead(actorId: string, organizationId: string) {
    await requireOperator(actorId);
    return transaction((tx) => estimate(tx, organizationId));
  },
  read(actorId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, actorId, organizationId, "billing.read");
      return estimate(tx, organizationId);
    });
  },
  updateEmail(
    actorId: string,
    organizationId: string,
    billingEmail: string | null,
  ) {
    return transaction(async (tx) => {
      await authorize(tx, actorId, organizationId, "billing.manage");
      const current = await repo.profile(tx, organizationId);
      if (!current)
        fail(404, "BILLING_PROFILE_NOT_FOUND", "Billing profile not found");
      await repo.updateEmail(
        tx,
        organizationId,
        billingEmail?.trim().toLowerCase() ?? null,
      );
      await audit.append(tx, {
        actorId,
        organizationId,
        action: "billing.profile.update",
        targetType: "OrganizationBillingProfile",
        targetId: current.id,
        metadata: { fields: ["billingEmail"] },
      });
      return estimate(tx, organizationId);
    });
  },
  async setStatus(
    actorId: string,
    organizationId: string,
    status: BillingStatus,
  ) {
    await requireOperator(actorId, true);
    return transaction(async (tx) => {
      const current = await repo.profile(tx, organizationId);
      if (!current)
        fail(404, "BILLING_PROFILE_NOT_FOUND", "Billing profile not found");
      await repo.updateStatus(tx, organizationId, status);
      await audit.append(tx, {
        actorId,
        organizationId,
        action: "billing.status.update",
        targetType: "OrganizationBillingProfile",
        targetId: current.id,
        metadata: { previousStatus: current.status, status },
      });
      return estimate(tx, organizationId);
    });
  },
  async summary(actorId: string) {
    await requireOperator(actorId);
    return transaction(async (tx) => {
      const [organizationCount, billableMemberCount, counts] = await Promise.all([
        repo.eligibleProfileCount(tx),
        repo.totalBillableMembers(tx),
        repo.statusCounts(tx),
      ]);
      return {
        currency: "USD" as const,
        basePriceMinor: BASE_PRICE_MINOR,
        memberPriceMinor: MEMBER_PRICE_MINOR,
        groupsCostMinor: 0,
        organizationCount,
        billableMemberCount,
        estimatedMonthlyMinor:
          organizationCount * BASE_PRICE_MINOR +
          billableMemberCount * MEMBER_PRICE_MINOR,
        byStatusScope: "ALL_PROFILES" as const,
        byStatus: counts.map((entry) => ({
          status: entry.status,
          count: entry._count._all,
        })),
      };
    });
  },
};

export const billingPolicy = {
  currency: "USD" as const,
  basePriceMinor: BASE_PRICE_MINOR,
  memberPriceMinor: MEMBER_PRICE_MINOR,
  groupsCostMinor: 0,
};
