import type { NorthCapability } from "../../authorization/policy.js";
import { isNorthCapability, northTenantCapabilities } from "../../authorization/policy.js";
import type { Transaction } from "../../../shared/transaction.js";
import { fail } from "../../../shared/errors.js";
import { resolveDatasetAcl } from "./acl-policy.js";
import { northDataRepository as repo } from "./repository.js";

export type DataMembership = NonNullable<Awaited<ReturnType<typeof repo.membership>>>;
type DatasetAclRule = Awaited<ReturnType<typeof repo.aclRules>>[number];

export async function requireDataMembership(tx: Transaction, userId: string, organizationId: string) {
  const organization = await repo.organization(tx, organizationId);
  if (!organization) fail(404, "NOT_FOUND", "Resource not found");
  if (organization.status !== "ACTIVE") fail(409, "ORGANIZATION_INACTIVE", "Organization is not active");
  const membership = await repo.membership(tx, organizationId, userId);
  if (!membership) fail(404, "NOT_FOUND", "Resource not found");
  if (membership.user.status !== "ACTIVE") fail(403, "FORBIDDEN", "Permission denied");
  return membership;
}

export async function hasOrganizationDataCapability(
  tx: Transaction,
  membership: Pick<DataMembership, "id" | "organizationId" | "role">,
  capability: NorthCapability,
) {
  if (!isNorthCapability(capability) || !northTenantCapabilities.includes(capability)) return false;
  if (membership.role === "OWNER" || membership.role === "ADMIN") return true;
  return repo.organizationCapabilityGrants(tx, membership, capability);
}

export async function requireOrganizationDataCapability(
  tx: Transaction,
  userId: string,
  organizationId: string,
  capability: NorthCapability,
) {
  const membership = await requireDataMembership(tx, userId, organizationId);
  if (!(await hasOrganizationDataCapability(tx, membership, capability)))
    fail(403, "FORBIDDEN", "Permission denied");
  return membership;
}

async function ruleMatches(
  tx: Transaction,
  membership: DataMembership,
  rule: DatasetAclRule,
  capabilityCache: Map<string, boolean>,
) {
  if (rule.principalType === "ALL_MEMBERS") return true;
  if (rule.principalType === "MEMBERSHIP") return rule.membershipId === membership.id;
  if (rule.principalType === "GROUP")
    return membership.groupMemberships.some((entry) => entry.groupId === rule.groupId);
  if (rule.principalType === "ROLE") return rule.role === membership.role;
  if (rule.principalType === "CAPABILITY" && rule.capability && isNorthCapability(rule.capability)) {
    if (!capabilityCache.has(rule.capability))
      capabilityCache.set(rule.capability, await hasOrganizationDataCapability(tx, membership, rule.capability));
    return capabilityCache.get(rule.capability) ?? false;
  }
  return false;
}

export async function datasetAclAllows(
  tx: Transaction,
  membership: DataMembership,
  rules: DatasetAclRule[],
) {
  const capabilityCache = new Map<string, boolean>();
  const decisions = [];
  for (const rule of rules)
    decisions.push({ effect: rule.effect, matches: await ruleMatches(tx, membership, rule, capabilityCache) });
  return resolveDatasetAcl(decisions);
}

export async function authorizeDataset(
  tx: Transaction,
  userId: string,
  organizationId: string,
  datasetId: string,
  capability: NorthCapability,
) {
  const dataset = await repo.dataset(tx, organizationId, datasetId);
  if (!dataset) fail(404, "NOT_FOUND", "Dataset not found");
  const membership = await requireOrganizationDataCapability(tx, userId, organizationId, capability);
  if (
    dataset.status === "ARCHIVED" &&
    !(await hasOrganizationDataCapability(tx, membership, "north.data.manage"))
  ) fail(404, "NOT_FOUND", "Dataset not found");
  const rules = await repo.aclRules(tx, organizationId, datasetId);
  if (!(await datasetAclAllows(tx, membership, rules))) fail(403, "FORBIDDEN", "Permission denied");
  return { dataset, membership, rules };
}

export async function assertDatasetOwnerAccess(
  tx: Transaction,
  organizationId: string,
  datasetId: string,
) {
  const [owners, rules] = await Promise.all([
    repo.ownerMemberships(tx, organizationId),
    repo.aclRules(tx, organizationId, datasetId),
  ]);
  for (const owner of owners)
    if (await datasetAclAllows(tx, owner, rules)) return;
  fail(409, "ACL_LOCKOUT_PREVENTED", "At least one active organization owner must retain dataset access");
}
