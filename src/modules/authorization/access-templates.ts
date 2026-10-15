import type { TenantRole } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorizeDataset } from "../north/data/authorization.js";
import { authorizeNorth, requireGrantAuthority } from "../north/authorization.js";
import { northRepository } from "../north/repository.js";
import { canManageRole, isPermission, type Permission } from "./policy.js";
import { authorize, resolvePermissions } from "./service.js";

export const TEMPLATE_ROLES = ["VIEWER", "MEMBER", "BILLING_ADMIN", "ADMIN"] as const;
export type TemplateInput = { name: string; description?: string | null; role: (typeof TEMPLATE_ROLES)[number]; permissions: string[]; datasetIds: string[]; groupIds: string[] };

const include = { datasets: { select: { datasetId: true } }, groups: { select: { groupId: true } } } as const;
const view = (row: { id: string; name: string; description: string | null; role: TenantRole; permissions: string[]; updatedAt: Date; datasets: { datasetId: string }[]; groups: { groupId: string }[] }) => ({
  id: row.id, name: row.name, description: row.description, role: row.role as (typeof TEMPLATE_ROLES)[number], permissions: row.permissions.filter(isPermission).sort() as Permission[],
  datasetIds: row.datasets.map((entry) => entry.datasetId).sort(), groupIds: row.groups.map((entry) => entry.groupId).sort(), updatedAt: row.updatedAt,
});

/** The actor may only put into a template what they could hand out themselves. */
async function assertAuthority(tx: Transaction, actorId: string, organizationId: string, input: Pick<TemplateInput, "role" | "permissions" | "datasetIds" | "groupIds">) {
  const resolved = await resolvePermissions(tx, actorId, organizationId);
  if (resolved.inspection) fail(403, "FORBIDDEN", "Platform inspection cannot manage templates");
  if (!canManageRole(resolved.member.role, input.role, input.role)) fail(403, "FORBIDDEN", "Cannot assign this role");
  for (const permission of input.permissions) {
    if (!isPermission(permission)) fail(422, "UNKNOWN_PERMISSION", "Permission is not registered");
    if (!resolved.permissions.includes(permission)) fail(403, "PRIVILEGE_ESCALATION", "You cannot hand out a permission you do not hold");
  }
  return resolved;
}

async function assertSameTenant(tx: Transaction, organizationId: string, input: Pick<TemplateInput, "datasetIds" | "groupIds">) {
  const [datasets, groups] = await Promise.all([
    tx.northDataset.count({ where: { organizationId, id: { in: input.datasetIds } } }),
    tx.organizationGroup.count({ where: { organizationId, id: { in: input.groupIds } } }),
  ]);
  if (datasets !== input.datasetIds.length || groups !== input.groupIds.length) fail(422, "CROSS_TENANT_RESOURCE", "A dataset or group is outside the organization");
}

/**
 * Gives one membership the dataset access a template describes. Reading a dataset takes two gates: the organization-scoped
 * `north.data.query` capability and a dataset rule that includes the person. Granting only the rule (what "assigning a
 * dataset" used to mean) leaves them with "Permission denied", so both are granted together here, with the same
 * authority checks as the individual endpoints.
 */
export async function grantMemberDatasetAccess(tx: Transaction, actorId: string, organizationId: string, membershipId: string, datasetIds: string[]) {
  if (datasetIds.length === 0) return { datasets: 0, capabilityGranted: false };
  await authorizeNorth(tx, actorId, "north.permission.manage", { organizationId, scope: "ORGANIZATION" });
  await requireGrantAuthority(tx, actorId, "north.data.query", { organizationId, scope: "ORGANIZATION" });
  for (const datasetId of datasetIds) await authorizeDataset(tx, actorId, organizationId, datasetId, "north.data.permission.manage");
  const has = await tx.northMembershipGrant.findFirst({ where: { organizationId, membershipId, capability: "north.data.query", scope: "ORGANIZATION" }, select: { id: true } });
  if (!has) await northRepository.grantMembership(tx, { organizationId, membershipId, capability: "north.data.query", scope: "ORGANIZATION" });
  for (const datasetId of datasetIds) {
    const rule = await tx.northDatasetAcl.findFirst({ where: { organizationId, datasetId, effect: "ALLOW", principalType: "MEMBERSHIP", membershipId }, select: { id: true } });
    if (!rule) await tx.northDatasetAcl.create({ data: { organizationId, datasetId, effect: "ALLOW", principalType: "MEMBERSHIP", membershipId, createdBy: actorId } });
  }
  return { datasets: datasetIds.length, capabilityGranted: !has };
}

export async function loadTemplate(tx: Transaction, organizationId: string, templateId: string) {
  const row = await tx.accessTemplate.findFirst({ where: { id: templateId, organizationId }, include });
  if (!row) fail(404, "NOT_FOUND", "Template not found");
  return view(row);
}

/** Applies a template's direct permissions, groups and dataset access to a membership (role is handled by the caller). */
export async function applyTemplateToMembership(tx: Transaction, actorId: string, organizationId: string, membershipId: string, template: ReturnType<typeof view>, options: { groups?: boolean } = {}) {
  if (template.permissions.length || template.groupIds.length) await authorize(tx, actorId, organizationId, "permissions.manage");
  await assertAuthority(tx, actorId, organizationId, template);
  for (const permission of template.permissions)
    await tx.membershipPermissionGrant.upsert({ where: { membershipId_permission: { membershipId, permission } }, create: { organizationId, membershipId, permission, grantedBy: actorId }, update: {} });
  if (options.groups !== false)
    for (const groupId of template.groupIds)
      await tx.organizationGroupMember.upsert({ where: { groupId_membershipId: { groupId, membershipId } }, create: { organizationId, groupId, membershipId }, update: {} });
  return grantMemberDatasetAccess(tx, actorId, organizationId, membershipId, template.datasetIds);
}

export const accessTemplates = {
  /** Anyone who can create accounts needs to read the templates to pick one. */
  list(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      const resolved = await resolvePermissions(tx, userId, organizationId);
      if (!resolved.permissions.includes("members.manage") && !resolved.permissions.includes("permissions.manage")) fail(403, "FORBIDDEN", "Permission denied");
      return (await tx.accessTemplate.findMany({ where: { organizationId }, include, orderBy: { name: "asc" }, take: 100 })).map(view);
    });
  },

  save(userId: string, organizationId: string, templateId: string | null, input: TemplateInput) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "permissions.manage");
      const normalized = { ...input, permissions: [...new Set(input.permissions)], datasetIds: [...new Set(input.datasetIds)], groupIds: [...new Set(input.groupIds)] };
      await assertAuthority(tx, userId, organizationId, normalized);
      await assertSameTenant(tx, organizationId, normalized);
      const data = { name: normalized.name.trim(), description: normalized.description?.trim() || null, role: normalized.role, permissions: normalized.permissions, updatedBy: userId };
      let id = templateId;
      try {
        if (templateId) {
          if (!(await tx.accessTemplate.findFirst({ where: { id: templateId, organizationId }, select: { id: true } }))) fail(404, "NOT_FOUND", "Template not found");
          await tx.accessTemplate.update({ where: { id: templateId }, data });
          await tx.accessTemplateDataset.deleteMany({ where: { templateId } });
          await tx.accessTemplateGroup.deleteMany({ where: { templateId } });
        } else id = (await tx.accessTemplate.create({ data: { ...data, organizationId } })).id;
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") fail(409, "TEMPLATE_NAME_TAKEN", "A template with this name already exists");
        throw error;
      }
      if (normalized.datasetIds.length) await tx.accessTemplateDataset.createMany({ data: normalized.datasetIds.map((datasetId) => ({ templateId: id!, organizationId, datasetId })) });
      if (normalized.groupIds.length) await tx.accessTemplateGroup.createMany({ data: normalized.groupIds.map((groupId) => ({ templateId: id!, organizationId, groupId })) });
      await audit.append(tx, { actorId: userId, organizationId, action: templateId ? "access.template.update" : "access.template.create", targetType: "AccessTemplate", targetId: id!, metadata: { role: normalized.role, permissions: normalized.permissions.length, datasets: normalized.datasetIds.length, groups: normalized.groupIds.length } });
      return loadTemplate(tx, organizationId, id!);
    });
  },

  remove(userId: string, organizationId: string, templateId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "permissions.manage");
      const gone = await tx.accessTemplate.deleteMany({ where: { id: templateId, organizationId } });
      if (gone.count !== 1) fail(404, "NOT_FOUND", "Template not found");
      await audit.append(tx, { actorId: userId, organizationId, action: "access.template.delete", targetType: "AccessTemplate", targetId: templateId });
      return null;
    });
  },

  /** Apply a template to an existing member: role (when it raises nothing the actor cannot grant), permissions, groups and data access. */
  applyToMember(userId: string, organizationId: string, targetUserId: string, templateId: string) {
    return transaction(async (tx) => {
      const actor = await authorize(tx, userId, organizationId, "members.manage");
      const target = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId: targetUserId } } });
      if (!target) fail(404, "NOT_FOUND", "Member not found");
      if (target.role === "OWNER") fail(409, "OWNER_PROTECTED", "Owners keep their own access; templates are for other roles");
      if (!canManageRole(actor.role, target.role, target.role)) fail(403, "FORBIDDEN", "Cannot manage this member");
      const template = await loadTemplate(tx, organizationId, templateId);
      // The template's role replaces the member's role only when the actor may grant it.
      if (template.role !== target.role) {
        if (!canManageRole(actor.role, target.role, template.role)) fail(403, "FORBIDDEN", "Cannot assign this role");
        await tx.membership.update({ where: { id: target.id }, data: { role: template.role } });
      }
      const result = await applyTemplateToMembership(tx, userId, organizationId, target.id, template);
      await audit.append(tx, { actorId: userId, organizationId, action: "access.template.apply", targetType: "membership", targetId: target.id, metadata: { templateId, role: template.role, datasets: result.datasets } });
      return { templateId, role: template.role, datasets: result.datasets, capabilityGranted: result.capabilityGranted };
    });
  },
};
