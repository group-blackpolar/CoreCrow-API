import { createHmac, randomBytes, randomInt } from "node:crypto";
import type { InvitationKind, TenantRole } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize } from "../authorization/service.js";
import { canManageRole, isPermission, type Permission } from "../authorization/policy.js";
import { groupsRepository as groups } from "../authorization/groups-repository.js";
import { hash as legacyHash } from "../security/crypto.js";
import { sendOrganizationInvitationMail } from "../security/mail.js";
import { tenantRepository as repo } from "./repository.js";

const EMAIL_TOKEN_BYTES = 32;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const DEFAULT_EXPIRY_HOURS = 7 * 24;

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

function invitationHash(value: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("Invitation security is not configured");
  return createHmac("sha256", secret)
    .update(`organization-invitation:${value}`)
    .digest("hex");
}

/** `SHARK-KEY-V7KD31M9Q2XA`: organization prefix + 12 unambiguous random characters (~60 bits). Security is the
 * server-side hash lookup, not the format. */
function organizationKey(slug: string) {
  const prefix = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "ORG";
  const random = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${prefix}-KEY-${random}`;
}

function rawCredential(kind: InvitationKind, slug: string) {
  return kind === "EMAIL" ? randomBytes(EMAIL_TOKEN_BYTES).toString("hex") : organizationKey(slug);
}

function invitationStatus(invitation: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}) {
  if (invitation.acceptedAt) return "ACCEPTED" as const;
  if (invitation.revokedAt) return "REVOKED" as const;
  if (invitation.expiresAt <= new Date()) return "EXPIRED" as const;
  return "PENDING" as const;
}

function view<T extends {
  id: string;
  organizationId: string;
  kind: InvitationKind;
  email: string | null;
  role: TenantRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  maxUses: number;
  useCount: number;
  createdByUserId: string | null;
  tokenHint: string | null;
  groupGrants: { groupId: string }[];
  permissionGrants: { permission: string }[];
}>(invitation: T) {
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
    maxUses: invitation.maxUses,
    useCount: invitation.useCount,
    createdByUserId: invitation.createdByUserId,
    keyHint: invitation.tokenHint,
    groupIds: invitation.groupGrants.map((grant) => grant.groupId).sort(),
    permissions: invitation.permissionGrants
      .map((grant) => grant.permission)
      .filter(isPermission)
      .sort(),
  };
}

type IssueInput = {
  kind: InvitationKind;
  email?: string;
  role: Exclude<TenantRole, "OWNER">;
  expiresInHours?: number;
  maxUses?: number;
  groupIds?: string[];
  permissions?: Permission[];
};

async function validateIssue(
  tx: Transaction,
  actorId: string,
  organizationId: string,
  input: IssueInput,
) {
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

async function createInvitation(
  tx: Transaction,
  actorId: string,
  organizationId: string,
  input: IssueInput,
) {
  const grants = await validateIssue(tx, actorId, organizationId, input);
  const email = input.email ? normalizedEmail(input.email) : undefined;
  const replaced = email
    ? await repo.revokePendingEmailInvitations(tx, organizationId, email)
    : { count: 0 };
  const organization = await repo.organization(tx, organizationId);
  if (!organization) fail(404, "NOT_FOUND", "Organization not found");
  const token = rawCredential(input.kind, organization.slug);
  const invitation = await repo.invite(tx, {
    organizationId,
    kind: input.kind,
    ...(email ? { email } : {}),
    role: input.role,
    tokenHash: invitationHash(token),
    tokenHint: token.slice(-4),
    createdByUserId: actorId,
    ...(input.kind === "CODE" ? { maxUses: input.maxUses ?? 1 } : {}),
    expiresAt: new Date(
      Date.now() + (input.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 60 * 60 * 1000,
    ),
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
      ...(input.kind === "CODE" ? { maxUses: input.maxUses ?? 1, keyHint: token.slice(-4) } : {}),
      groupCount: grants.groupIds.length,
      permissionCount: grants.permissions.length,
      replacedPendingCount: replaced.count,
    },
  });
  return { invitation, token };
}

async function deliverEmail(
  organizationId: string,
  email: string | null,
  token: string,
  expiresAt: Date,
) {
  if (!email) return "not_applicable" as const;
  const organization = await transaction((tx) => repo.organization(tx, organizationId));
  if (!organization) return "failed" as const;
  const northUrl = process.env.NORTH_PUBLIC_URL ?? "https://north.blackpolar.org";
  const url = new URL(northUrl);
  url.searchParams.set("invitation", token);
  try {
    await sendOrganizationInvitationMail(email, organization.name, url.toString(), expiresAt);
    return "sent" as const;
  } catch {
    return "failed" as const;
  }
}

export const invitations = {
  list(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "invitations.read");
      return (await repo.invitations(tx, organizationId)).map(view);
    });
  },
  async issue(userId: string, organizationId: string, input: IssueInput) {
    const created = await transaction((tx) =>
      createInvitation(tx, userId, organizationId, input),
    );
    const delivery = await deliverEmail(
      organizationId,
      created.invitation.email,
      created.token,
      created.invitation.expiresAt,
    );
    return {
      ...view(created.invitation),
      ...(created.invitation.kind === "CODE" ? { token: created.token } : {}),
      delivery,
    };
  },
  async replace(userId: string, organizationId: string, invitationId: string) {
    const created = await transaction(async (tx) => {
      const previous = await repo.invitationById(tx, invitationId, organizationId);
      if (!previous) fail(404, "NOT_FOUND", "Invitation not found");
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
        ...(previous.kind === "CODE" ? { maxUses: previous.maxUses } : {}),
        ...(previous.email ? { email: previous.email } : {}),
        role: previous.role as Exclude<TenantRole, "OWNER">,
        groupIds: previous.groupGrants.map((grant) => grant.groupId),
        permissions: previous.permissionGrants
          .map((grant) => grant.permission)
          .filter(isPermission),
      });
    });
    const delivery = await deliverEmail(
      organizationId,
      created.invitation.email,
      created.token,
      created.invitation.expiresAt,
    );
    return {
      ...view(created.invitation),
      ...(created.invitation.kind === "CODE" ? { token: created.token } : {}),
      delivery,
    };
  },
  accept(
    user: { id: string; email: string; emailVerified: boolean },
    credentialInput: string,
  ) {
    return transaction(async (tx) => {
      const credential = credentialInput.trim();
      const variants = [...new Set([credential, credential.toUpperCase()])];
      const hashes = variants.flatMap((value) => [invitationHash(value), legacyHash(value)]);
      const invitation = await repo.invitation(tx, hashes);
      if (
        !invitation ||
        invitation.revokedAt ||
        invitation.acceptedAt ||
        invitation.expiresAt <= new Date()
      )
        fail(404, "INVITATION_INVALID", "Invitation unavailable");
      if (!user.emailVerified)
        fail(403, "VERIFIED_EMAIL_REQUIRED", "A verified email is required");
      if (
        invitation.kind === "EMAIL" &&
        normalizedEmail(user.email) !== invitation.email
      )
        fail(403, "INVITATION_EMAIL_MISMATCH", "The invitation belongs to another email");
      const membership = await repo.accept(
        tx,
        invitation.id,
        invitation.organizationId,
        user.id,
        invitation.role,
      );
      if (!membership) fail(404, "INVITATION_INVALID", "Invitation unavailable");
      await repo.addInvitationGrants(
        tx,
        invitation.organizationId,
        membership.id,
        invitation.groupGrants.map((grant) => grant.groupId),
        invitation.permissionGrants
          .map((grant) => grant.permission)
          .filter(isPermission),
      );
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
  /** Public pre-check used by sign-up and the empty state; reveals only the organization's public identity. */
  async validate(credentialInput: string) {
    const credential = credentialInput.trim();
    const variants = [...new Set([credential, credential.toUpperCase()])];
    const hashes = variants.flatMap((value) => [invitationHash(value), legacyHash(value)]);
    return transaction(async (tx) => {
      const invitation = await repo.invitation(tx, hashes);
      if (
        !invitation ||
        invitation.revokedAt ||
        invitation.acceptedAt ||
        invitation.expiresAt <= new Date()
      )
        fail(404, "INVITATION_INVALID", "Invitation unavailable");
      const organization = await repo.organization(tx, invitation.organizationId);
      if (!organization || organization.status !== "ACTIVE")
        fail(404, "INVITATION_INVALID", "Invitation unavailable");
      return {
        organization: { name: organization.name, slug: organization.slug, iconData: organization.iconData },
        kind: invitation.kind,
        expiresAt: invitation.expiresAt,
      };
    });
  },
  /** Org admins check whether an account already exists for an email (needs members.manage). */
  lookupUser(userId: string, organizationId: string, emailInput: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "members.manage");
      const found = await repo.userByEmail(tx, normalizedEmail(emailInput));
      if (!found || found.status !== "ACTIVE") return { exists: false as const, user: null, alreadyMember: false };
      const membership = await repo.membership(tx, organizationId, found.id);
      return {
        exists: true as const,
        user: { id: found.id, email: found.email, name: found.name, emailVerified: found.emailVerified },
        alreadyMember: Boolean(membership),
      };
    });
  },
  /** Adds an existing verified account directly. Unknown accounts must go through an invitation. */
  addExistingMember(
    userId: string,
    organizationId: string,
    input: { email: string; role: Exclude<TenantRole, "OWNER">; groupIds?: string[] },
  ) {
    return transaction(async (tx) => {
      const actor = await authorize(tx, userId, organizationId, "members.manage");
      if (!canManageRole(actor.role, input.role, input.role))
        fail(403, "FORBIDDEN", "Cannot assign this role");
      const groupIds = [...new Set(input.groupIds ?? [])];
      if (groupIds.length) await authorize(tx, userId, organizationId, "permissions.manage");
      for (const groupId of groupIds)
        if (!(await groups.group(tx, organizationId, groupId)))
          fail(404, "NOT_FOUND", "Group not found");
      const target = await repo.userByEmail(tx, normalizedEmail(input.email));
      if (!target || target.status !== "ACTIVE" || !target.emailVerified)
        fail(404, "USER_NOT_FOUND", "No verified account exists for this email");
      if (await repo.membership(tx, organizationId, target.id))
        fail(409, "ALREADY_MEMBER", "The user already belongs to this organization");
      const membership = await repo.addMember(tx, organizationId, target.id, input.role);
      await repo.addInvitationGrants(tx, organizationId, membership.id, groupIds, []);
      await audit.append(tx, {
        actorId: userId,
        organizationId,
        action: "membership.add",
        targetType: "membership",
        targetId: membership.id,
        metadata: { role: input.role, groupCount: groupIds.length },
      });
      return membership;
    });
  },
  revoke(userId: string, organizationId: string, invitationId: string) {
    return transaction(async (tx) => {
      const actor = await authorize(tx, userId, organizationId, "invitations.manage");
      const invitation = await repo.invitationById(tx, invitationId, organizationId);
      if (!invitation) fail(404, "NOT_FOUND", "Invitation not found");
      if (!canManageRole(actor.role, invitation.role))
        fail(403, "FORBIDDEN", "Cannot revoke this invitation");
      if (!invitation.revokedAt) await repo.revoke(tx, invitationId);
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
