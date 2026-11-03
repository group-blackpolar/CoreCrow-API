import { fail } from "../../shared/errors.js";
import type { Transaction } from "../../shared/transaction.js";
import { assertNetworkAllowed } from "../security-access/enforcement.js";
import { tenantRepository } from "../tenancy/repository.js";

/**
 * RM-021: the one door through which an actor is admitted to a tenant. Every authorization path (permissions, NORTH capabilities,
 * dataset access, navigation, search, audience) reaches the organization's network rules (R-006) only through here;
 * `tests/tenant-access.test.ts` fails if anything else imports the enforcement directly.
 */
export const tenantAccess = {
  /** The actor is already known to be a member: enforce the organization's network rules (memoized per request). */
  admit: (tx: Transaction, organizationId: string, userId: string) => assertNetworkAllowed(tx, organizationId, userId),

  /** The actor's membership, or null. When it exists the organization's network rules are enforced before it is returned. */
  async member(tx: Transaction, organizationId: string, userId: string) {
    const membership = await tenantRepository.membership(tx, organizationId, userId);
    if (membership) await assertNetworkAllowed(tx, organizationId, userId);
    return membership;
  },

  /** 409 unless the organization is ACTIVE. A read-only platform inspection of this organization passes `inspected`. */
  requireActive(organization: { status: string }, inspected = false) {
    if (!inspected && organization.status !== "ACTIVE") fail(409, "ORGANIZATION_INACTIVE", "Organization is not active");
  },

  /** Suspended organizations refuse everything (403); archived ones only allow organization.read/update (409). Inspection is exempt. */
  requireOperable(organization: { status: string }, permission: string, inspected = false) {
    if (inspected) return;
    if (organization.status === "SUSPENDED") fail(403, "ORGANIZATION_SUSPENDED", "Organization is suspended");
    if (organization.status === "ARCHIVED" && permission !== "organization.read" && permission !== "organization.update")
      fail(409, "ORGANIZATION_INACTIVE", "Organization is not active");
  },
};
