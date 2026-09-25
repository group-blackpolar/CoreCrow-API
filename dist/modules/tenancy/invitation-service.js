import { createHmac, randomBytes, randomInt } from "node:crypto";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize } from "../authorization/service.js";
import { canManageRole, isPermission } from "../authorization/policy.js";
import { groupsRepository as groups } from "../authorization/groups-repository.js";
import { hash as legacyHash } from "../security/crypto.js";
import { sendOrganizationInvitationMail } from "../security/mail.js";
import { tenantRepository as repo } from "./repository.js";
const EMAIL_TOKEN_BYTES = 32;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const DEFAULT_EXPIRY_HOURS = 7 * 24;
function normalizedEmail(value) {
    return value.trim().toLowerCase();
}
function invitationHash(value) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret)
        throw new Error("Invitation security is not configured");
    return createHmac("sha256", secret)
        .update(`organization-invitation:${value}`)
        .digest("hex");
}
function genericCode() {
    const characters = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    return `BP-${characters.slice(0, 4)}-${characters.slice(4, 8)}-${characters.slice(8)}`;
}
function rawCredential(kind) {
    return kind === "EMAIL"
        ? randomBytes(EMAIL_TOKEN_BYTES).toString("hex")
        : genericCode();
}
function invitationStatus(invitation) {
    if (invitation.acceptedAt)
        return "ACCEPTED";
    if (invitation.revokedAt)
        return "REVOKED";
    if (invitation.expiresAt <= new Date())
        return "EXPIRED";
    return "PENDING";
}
function view(invitation) {
    return {
        id: invitation.id,
        organizationId: invitation.organizationId,
        kind: invitation.kind,
        email: invitation.email,
        role: invitation.role,
        status: invitationStatus(invitation),
        expiresAt: invitation.expiresAt,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
        createdAt: invitation.createdAt,
        groupIds: invitation.groupGrants.map((grant) => grant.groupId).sort(),
        permissions: invitation.permissionGrants
            .map((grant) => grant.permission)
            .filter(isPermission)
            .sort(),
    };
}
async function validateIssue(tx, actorId, organizationId, input) {
    const actor = await authorize(tx, actorId, organizationId, "invitations.manage");
    if (!canManageRole(actor.role, input.role, input.role))
        fail(403, "FORBIDDEN", "Cannot invite this role");
    if (input.kind === "EMAIL" && !input.email)
        fail(400, "INVITATION_EMAIL_REQUIRED", "Email invitations require an email");
    if (input.kind === "CODE" && input.email)
        fail(400, "INVITATION_EMAIL_NOT_ALLOWED", "Generic codes cannot target an email");
    const groupIds = [...new Set(input.groupIds ?? [])];
    const permissions = [...new Set(input.permissions ?? [])];
    if (groupIds.length || permissions.length)
        await authorize(tx, actorId, organizationId, "permissions.manage");
    for (const groupId of groupIds)
        if (!(await groups.group(tx, organizationId, groupId)))
            fail(404, "NOT_FOUND", "Group not found");
    return {
        groupIds,
        permissions,
    };
}
async function createInvitation(tx, actorId, organizationId, input) {
    const grants = await validateIssue(tx, actorId, organizationId, input);
    const email = input.email ? normalizedEmail(input.email) : undefined;
    const replaced = email
        ? await repo.revokePendingEmailInvitations(tx, organizationId, email)
        : { count: 0 };
    const token = rawCredential(input.kind);
    const invitation = await repo.invite(tx, {
        organizationId,
        kind: input.kind,
        ...(email ? { email } : {}),
        role: input.role,
        tokenHash: invitationHash(token),
        expiresAt: new Date(Date.now() + (input.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 60 * 60 * 1000),
        ...grants,
    });
    await audit.append(tx, {
        actorId,
        organizationId,
        action: "invitation.create",
        targetType: "invitation",
        targetId: invitation.id,
        metadata: {
            kind: input.kind,
            role: input.role,
            groupCount: grants.groupIds.length,
            permissionCount: grants.permissions.length,
            replacedPendingCount: replaced.count,
        },
    });
    return { invitation, token };
}
async function deliverEmail(organizationId, email, token, expiresAt) {
    if (!email)
        return "not_applicable";
    const organization = await transaction((tx) => repo.organization(tx, organizationId));
    if (!organization)
        return "failed";
    const northUrl = process.env.NORTH_PUBLIC_URL ?? "https://north.blackpolar.org";
    const url = new URL(northUrl);
    url.searchParams.set("invitation", token);
    try {
        await sendOrganizationInvitationMail(email, organization.name, url.toString(), expiresAt);
        return "sent";
    }
    catch {
        return "failed";
    }
}
export const invitations = {
    list(userId, organizationId) {
        return transaction(async (tx) => {
            await authorize(tx, userId, organizationId, "invitations.manage");
            return (await repo.invitations(tx, organizationId)).map(view);
        });
    },
    async issue(userId, organizationId, input) {
        const created = await transaction((tx) => createInvitation(tx, userId, organizationId, input));
        const delivery = await deliverEmail(organizationId, created.invitation.email, created.token, created.invitation.expiresAt);
        return {
            ...view(created.invitation),
            ...(created.invitation.kind === "CODE" ? { token: created.token } : {}),
            delivery,
        };
    },
    async replace(userId, organizationId, invitationId) {
        const created = await transaction(async (tx) => {
            const previous = await repo.invitationById(tx, invitationId, organizationId);
            if (!previous)
                fail(404, "NOT_FOUND", "Invitation not found");
            const actor = await authorize(tx, userId, organizationId, "invitations.manage");
            if (!canManageRole(actor.role, previous.role))
                fail(403, "FORBIDDEN", "Cannot replace this invitation");
            if (previous.acceptedAt)
                fail(409, "INVITATION_ALREADY_ACCEPTED", "Accepted invitations cannot be replaced");
            await repo.revoke(tx, previous.id);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "invitation.replace",
                targetType: "invitation",
                targetId: previous.id,
            });
            return createInvitation(tx, userId, organizationId, {
                kind: previous.kind,
                ...(previous.email ? { email: previous.email } : {}),
                role: previous.role,
                groupIds: previous.groupGrants.map((grant) => grant.groupId),
                permissions: previous.permissionGrants
                    .map((grant) => grant.permission)
                    .filter(isPermission),
            });
        });
        const delivery = await deliverEmail(organizationId, created.invitation.email, created.token, created.invitation.expiresAt);
        return {
            ...view(created.invitation),
            ...(created.invitation.kind === "CODE" ? { token: created.token } : {}),
            delivery,
        };
    },
    accept(user, credentialInput) {
        return transaction(async (tx) => {
            const credential = credentialInput.trim();
            const variants = [...new Set([credential, credential.toUpperCase()])];
            const hashes = variants.flatMap((value) => [invitationHash(value), legacyHash(value)]);
            const invitation = await repo.invitation(tx, hashes);
            if (!invitation ||
                invitation.revokedAt ||
                invitation.acceptedAt ||
                invitation.expiresAt <= new Date())
                fail(404, "INVITATION_INVALID", "Invitation unavailable");
            if (!user.emailVerified)
                fail(403, "VERIFIED_EMAIL_REQUIRED", "A verified email is required");
            if (invitation.kind === "EMAIL" &&
                normalizedEmail(user.email) !== invitation.email)
                fail(403, "INVITATION_EMAIL_MISMATCH", "The invitation belongs to another email");
            const membership = await repo.accept(tx, invitation.id, invitation.organizationId, user.id, invitation.role);
            if (!membership)
                fail(404, "INVITATION_INVALID", "Invitation unavailable");
            await repo.addInvitationGrants(tx, invitation.organizationId, membership.id, invitation.groupGrants.map((grant) => grant.groupId), invitation.permissionGrants
                .map((grant) => grant.permission)
                .filter(isPermission));
            await audit.append(tx, {
                actorId: user.id,
                organizationId: invitation.organizationId,
                action: "invitation.accept",
                targetType: "invitation",
                targetId: invitation.id,
                metadata: { kind: invitation.kind },
            });
            return membership;
        });
    },
    revoke(userId, organizationId, invitationId) {
        return transaction(async (tx) => {
            const actor = await authorize(tx, userId, organizationId, "invitations.manage");
            const invitation = await repo.invitationById(tx, invitationId, organizationId);
            if (!invitation)
                fail(404, "NOT_FOUND", "Invitation not found");
            if (!canManageRole(actor.role, invitation.role))
                fail(403, "FORBIDDEN", "Cannot revoke this invitation");
            if (!invitation.revokedAt)
                await repo.revoke(tx, invitationId);
            await audit.append(tx, {
                actorId: userId,
                organizationId,
                action: "invitation.revoke",
                targetType: "invitation",
                targetId: invitationId,
            });
        });
    },
};
export const invitationPolicy = {
    defaultExpiryHours: DEFAULT_EXPIRY_HOURS,
    emailTokenBytes: EMAIL_TOKEN_BYTES,
};
