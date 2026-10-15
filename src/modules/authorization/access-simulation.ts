import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { datasetAclAllows, hasOrganizationDataCapability } from "../north/data/authorization.js";
import { northDataRepository } from "../north/data/repository.js";
import { northPanelAudienceAllows } from "../north/audience.js";
import { hasNorthCapability } from "../north/authorization.js";
import { authorize } from "./service.js";
import { permissions as registeredPermissions, effectivePermissions, type Permission } from "./policy.js";

export type PermissionOrigin = { type: "ROLE" | "GROUP" | "DIRECT"; id?: string; name?: string };
export type DatasetReason = "OK" | "ARCHIVED" | "NO_QUERY_CAPABILITY" | "ACL_DENIED";
export type PanelReason = "OK" | "NO_READ_PERMISSION" | "AUDIENCE_DENIED" | "UNSUPPORTED_POLICY";

const MAX_DATASETS = 200;
const MAX_PANELS = 300;

/**
 * "View as this user": a read-only simulation of what CORECROW would decide for a member. It runs the same checks the real
 * requests run (role + group + direct grants, NORTH capabilities, dataset ACL, panel audience) against the target's identity,
 * but never creates a session, never returns data rows and never exposes the target's credentials. Reading it needs
 * `permissions.manage`, the same privilege that lets the actor change this access in the first place, and each use is audited.
 */
export const accessSimulation = {
  simulate(actorId: string, organizationId: string, targetUserId: string) {
    return transaction(async (tx) => {
      await authorize(tx, actorId, organizationId, "permissions.manage");
      const membership = await northDataRepository.membership(tx, organizationId, targetUserId);
      if (!membership) fail(404, "NOT_FOUND", "Member not found");
      const [user, groupRows, directRows] = await Promise.all([
        tx.user.findUnique({ where: { id: targetUserId }, select: { id: true, name: true, email: true, role: true, status: true } }),
        tx.groupPermissionGrant.findMany({ where: { organizationId, group: { memberships: { some: { membershipId: membership.id } } } }, select: { permission: true, group: { select: { id: true, name: true } } } }),
        tx.membershipPermissionGrant.findMany({ where: { organizationId, membershipId: membership.id, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { permission: true } }),
      ]);
      const groups = await tx.organizationGroup.findMany({ where: { organizationId, memberships: { some: { membershipId: membership.id } } }, select: { id: true, name: true }, orderBy: { name: "asc" } });

      // 1) Tenant permissions with where each one comes from.
      const origins = new Map<Permission, PermissionOrigin[]>();
      const add = (permission: string, origin: PermissionOrigin) => {
        if (!(registeredPermissions as readonly string[]).includes(permission)) return;
        const list = origins.get(permission as Permission) ?? [];
        list.push(origin);
        origins.set(permission as Permission, list);
      };
      for (const permission of effectivePermissions(membership.role)) add(permission, { type: "ROLE", name: membership.role });
      for (const row of groupRows) add(row.permission, { type: "GROUP", id: row.group.id, name: row.group.name });
      for (const row of directRows) add(row.permission, { type: "DIRECT" });
      const permissions = registeredPermissions.filter((permission) => origins.has(permission)).map((permission) => ({ permission, origins: origins.get(permission)! }));

      // 2) Datasets: the two gates (north.data.query + ACL) reported separately so "why not" is answerable.
      const canQuery = await hasOrganizationDataCapability(tx, membership, "north.data.query");
      const canManageData = await hasOrganizationDataCapability(tx, membership, "north.data.manage");
      const datasetRows = await tx.northDataset.findMany({ where: { organizationId }, select: { id: true, name: true, slug: true, status: true }, orderBy: { createdAt: "asc" }, take: MAX_DATASETS });
      const datasets = [];
      for (const dataset of datasetRows) {
        let reason: DatasetReason = "OK";
        if (dataset.status === "ARCHIVED" && !canManageData) reason = "ARCHIVED";
        else if (!canQuery) reason = "NO_QUERY_CAPABILITY";
        else if (!(await datasetAclAllows(tx, membership, await northDataRepository.aclRules(tx, organizationId, dataset.id)))) reason = "ACL_DENIED";
        datasets.push({ id: dataset.id, name: dataset.name as Record<string, string>, slug: dataset.slug, status: dataset.status, canQuery: reason === "OK", reason });
      }

      // 3) Published views: capability + audience, the same decision the published-panel endpoints make.
      const panelRows = await tx.northPanel.findMany({
        where: { organizationId, status: "PUBLISHED", resourceKind: "CONTENT", publishedRevisionId: { not: null } },
        include: { subcategory: true, audienceRoles: true, audienceGroups: true, audiencePermissions: true, audienceMemberships: true },
        orderBy: { createdAt: "asc" }, take: MAX_PANELS,
      });
      const panels = [];
      for (const panel of panelRows) {
        const target = { organizationId, scope: "PANEL" as const, categoryId: panel.subcategory.categoryId, subcategoryId: panel.subcategoryId, panelId: panel.id };
        let reason: PanelReason = "OK";
        if (panel.accessPolicyMode === "ACL_V1") reason = "UNSUPPORTED_POLICY";
        else if (!(await hasNorthCapability(tx, targetUserId, "north.panel.read", target)) || !(await hasNorthCapability(tx, targetUserId, "north.content.read", target))) reason = "NO_READ_PERMISSION";
        else if (!(await northPanelAudienceAllows(tx, targetUserId, panel, panel.subcategory.categoryId))) reason = "AUDIENCE_DENIED";
        panels.push({ id: panel.id, name: panel.name as Record<string, string>, slug: panel.slug, visible: reason === "OK", reason });
      }

      await audit.append(tx, { actorId, organizationId, action: "access.simulation.view", targetType: "membership", targetId: membership.id, metadata: { datasets: datasets.length, panels: panels.length } });
      return {
        user: { id: user!.id, name: user!.name, email: user!.email, status: user!.status },
        role: membership.role,
        platformRole: user!.role,
        groups,
        permissions,
        data: { canQuery, canManage: canManageData, datasets, truncated: datasetRows.length === MAX_DATASETS },
        views: { panels, truncated: panelRows.length === MAX_PANELS },
        notes: { platformPrivileges: user!.role === "SUPERADMIN" ? "SUPERADMIN bypasses tenant checks; the lists above describe tenant rules only." : null },
      };
    });
  },
};
