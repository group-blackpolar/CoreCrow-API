import { authorize, resolvePermissions } from "./service.js";
import { groupsRepository as groups } from "./groups-repository.js";
import { tenantRepository as tenants } from "../tenancy/repository.js";
import { auditRepository as audit } from "../audit/repository.js";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
async function requireGroup(tx, organizationId, groupId) {
    const group = await groups.group(tx, organizationId, groupId);
    if (!group)
        fail(404, "NOT_FOUND", "Group not found");
    return group;
}
async function requireMembership(tx, organizationId, userId) {
    const membership = await tenants.membership(tx, organizationId, userId);
    if (!membership)
        fail(404, "NOT_FOUND", "Member not found");
    return membership;
}
export const authorizationGroups = {
    list(userId, organizationId) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "groups.read");
            const records = await groups.list(tx, organizationId);
            return records.map(({ memberships, permissionGrants, ...group }) => ({
                ...group,
                memberUserIds: memberships
                    .map((entry) => entry.membership.userId)
                    .sort(),
                permissions: permissionGrants
                    .map((entry) => entry.permission)
                    .sort(),
            }));
        });
    },
    create(userId, organizationId, data) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "groups.manage");
            if (await groups.named(tx, organizationId, data.name))
                fail(409, "GROUP_NAME_TAKEN", "A group with this name already exists");
            const group = await groups.create(tx, organizationId, data);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.group.create",
                targetType: "organization_group",
                targetId: group.id,
            });
            return group;
        });
    },
    update(userId, organizationId, groupId, data) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "groups.manage");
            await requireGroup(tx, organizationId, groupId);
            if (data.name) {
                const duplicate = await groups.named(tx, organizationId, data.name);
                if (duplicate && duplicate.id !== groupId)
                    fail(409, "GROUP_NAME_TAKEN", "A group with this name already exists");
            }
            const group = await groups.update(tx, groupId, data);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.group.update",
                targetType: "organization_group",
                targetId: groupId,
                metadata: { fields: Object.keys(data).sort() },
            });
            return group;
        });
    },
    remove(userId, organizationId, groupId) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "groups.manage");
            await requireGroup(tx, organizationId, groupId);
            await groups.remove(tx, groupId);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.group.delete",
                targetType: "organization_group",
                targetId: groupId,
            });
        });
    },
    addMember(userId, organizationId, groupId, targetUserId) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "groups.manage");
            await requireGroup(tx, organizationId, groupId);
            const membership = await requireMembership(tx, organizationId, targetUserId);
            const result = await groups.addMember(tx, organizationId, groupId, membership.id);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.group.member.add",
                targetType: "membership",
                targetId: membership.id,
                metadata: { groupId },
            });
            return { ...result, userId: targetUserId };
        });
    },
    removeMember(userId, organizationId, groupId, targetUserId) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "groups.manage");
            await requireGroup(tx, organizationId, groupId);
            const membership = await requireMembership(tx, organizationId, targetUserId);
            await groups.removeMember(tx, groupId, membership.id);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.group.member.remove",
                targetType: "membership",
                targetId: membership.id,
                metadata: { groupId },
            });
        });
    },
    grantGroup(userId, organizationId, groupId, permission) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "permissions.manage");
            await requireGroup(tx, organizationId, groupId);
            const grant = await groups.grantGroup(tx, organizationId, groupId, permission);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.group.permission.grant",
                targetType: "organization_group",
                targetId: groupId,
                metadata: { permission },
            });
            return grant;
        });
    },
    revokeGroup(userId, organizationId, groupId, permission) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "permissions.manage");
            await requireGroup(tx, organizationId, groupId);
            await groups.revokeGroup(tx, groupId, permission);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.group.permission.revoke",
                targetType: "organization_group",
                targetId: groupId,
                metadata: { permission },
            });
        });
    },
    direct(userId, organizationId, targetUserId) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "permissions.manage");
            const membership = await requireMembership(tx, organizationId, targetUserId);
            const grants = await groups.directGrants(tx, organizationId, membership.id);
            return grants.map((grant) => grant.permission);
        });
    },
    grantDirect(userId, organizationId, targetUserId, permission) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "permissions.manage");
            const membership = await requireMembership(tx, organizationId, targetUserId);
            const grant = await groups.grantDirect(tx, organizationId, membership.id, permission);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.member.permission.grant",
                targetType: "membership",
                targetId: membership.id,
                metadata: { permission },
            });
            return grant;
        });
    },
    revokeDirect(userId, organizationId, targetUserId, permission) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "permissions.manage");
            const membership = await requireMembership(tx, organizationId, targetUserId);
            await groups.revokeDirect(tx, membership.id, permission);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "authorization.member.permission.revoke",
                targetType: "membership",
                targetId: membership.id,
                metadata: { permission },
            });
        });
    },
    effective(userId, organizationId) {
        return transaction(async (tx) => {
            const resolved = await resolvePermissions(tx, userId, organizationId);
            if (!resolved.permissions.includes("organization.read"))
                fail(403, "FORBIDDEN", "Permission denied");
            return { role: resolved.member.role, permissions: resolved.permissions };
        });
    },
};
