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
};
