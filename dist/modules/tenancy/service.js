import { randomBytes } from "node:crypto";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { tenantRepository as repo } from "./repository.js";
import { authorize } from "../authorization/service.js";
import { canManageRole } from "../authorization/policy.js";
import { auditRepository as audit } from "../audit/repository.js";
import { hash } from "../security/crypto.js";
export const tenants = {
    list: repo.list,
    create(userId, data) {
        return transaction(async (tx) => {
            const org = await repo.create(tx, userId, data);
            await audit.append(tx, {
                actorId: userId,
                organizationId: org.id,
                action: "organization.create",
                targetId: org.id,
            });
            return org;
        });
    },
    read(userId, organizationId) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "organization.read");
            return repo.organization(tx, organizationId);
        });
    },
    update(userId, organizationId, name) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "organization.update");
            const org = await repo.update(tx, organizationId, name);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "organization.update",
                targetId: organizationId,
            });
            return org;
        });
    },
    members(userId, organizationId) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "members.read");
            return repo.members(tx, organizationId);
        });
    },
    changeMember(userId, organizationId, targetUserId, role) {
        return transaction(async (tx) => {
            const actor = await authorize(tx, userId, organizationId, "members.manage");
            const target = await repo.membership(tx, organizationId, targetUserId);
            if (!target)
                fail(404, "NOT_FOUND", "Member not found");
            if (!canManageRole(actor.role, target.role, role))
                fail(403, "FORBIDDEN", "Cannot manage this role");
            if (target.role === "OWNER" &&
                role !== "OWNER" &&
                (await repo.owners(tx, organizationId)) <= 1)
                fail(409, "LAST_OWNER", "An organization must retain an owner");
            const result = role
                ? await repo.setRole(tx, target.id, role)
                : await repo.remove(tx, target.id);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: role ? "membership.role.update" : "membership.remove",
                targetId: target.id,
            });
            return result;
        });
    },
    invite(userId, organizationId, email, role) {
        return transaction(async (tx) => {
            const actor = await authorize(tx, userId, organizationId, "invitations.manage");
            if (role === "OWNER" || !canManageRole(actor.role, role, role))
                fail(403, "FORBIDDEN", "Cannot invite this role");
            const token = randomBytes(32).toString("hex");
            const invitation = await repo.invite(tx, {
                organizationId,
                email: email.toLowerCase(),
                role,
                tokenHash: hash(token),
                expiresAt: new Date(Date.now() + 7 * 86400000),
            });
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "invitation.create",
                targetId: invitation.id,
            });
            return {
                id: invitation.id,
                email: invitation.email,
                role,
                expiresAt: invitation.expiresAt,
                token,
            };
        });
    },
    accept(user, token) {
        return transaction(async (tx) => {
            const invite = await repo.invitation(tx, hash(token));
            if (!invite ||
                invite.revokedAt ||
                invite.acceptedAt ||
                invite.expiresAt <= new Date())
                fail(404, "INVITATION_INVALID", "Invitation unavailable");
            if (!user.emailVerified || user.email.toLowerCase() !== invite.email)
                fail(403, "FORBIDDEN", "A verified matching email is required");
            const member = await repo.accept(tx, invite.id, invite.organizationId, user.id, invite.role);
            await audit.append(tx, {
                actorId: user.id,
                organizationId: invite.organizationId,
                action: "invitation.accept",
                targetId: invite.id,
            });
            return member;
        });
    },
    revoke(userId, organizationId, id) {
        return transaction(async (tx) => {
            const actor = await authorize(tx, userId, organizationId, "invitations.manage");
            const invite = await repo.invitationById(tx, id, organizationId);
            if (!invite)
                fail(404, "NOT_FOUND", "Invitation not found");
            if (!canManageRole(actor.role, invite.role))
                fail(403, "FORBIDDEN", "Cannot revoke this invitation");
            await repo.revoke(tx, id);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "invitation.revoke",
                targetId: id,
            });
        });
    },
};
