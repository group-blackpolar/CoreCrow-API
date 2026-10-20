import { createHmac, randomBytes, randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import type { InvitationKind, TenantRole } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize } from "../authorization/service.js";
import { readOrganizationPolicy } from "./policy.js";
import { applyTemplateToMembership, loadTemplate } from "../authorization/access-templates.js";
import { canManageRole, isPermission, type Permission } from "../authorization/policy.js";
import { groupsRepository as groups } from "../authorization/groups-repository.js";
import { hash as legacyHash } from "../security/crypto.js";
import { sendOrganizationInvitationMail } from "../security/mail.js";
import { tenantRepository as repo } from "./repository.js";
import { identities } from "../identity/repository.js";

const EMAIL_TOKEN_BYTES = 32;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const DEFAULT_EXPIRY_HOURS = 7 * 24;

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}


const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** `SHARK-PASS-8nHFG31zTL`: organization prefix + 10 random characters (~58 bits); only its hash is ever stored. */
export function generatedPassword(slug: string) {
  const prefix = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) || "ORG";
  const random = Array.from({ length: 10 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");
  return `${prefix}-PASS-${random}`;
}

/** Login addresses of an organization's own accounts live under `<slug>.bp`. */
export const organizationDomain = (slug: string) => `${slug.toLowerCase()}.bp`;

/** `Samuel Perez` -> `samuel`: the first word, accents removed, only characters that are safe in an address. */
/** Alias fragment for a group: lowercase ASCII letters and digits only, at most 20 characters ("Finanzas Chile" -> "finanzaschile"). */
export function groupAliasSlug(name: string) {
  const clean = name.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
  return clean || "grupo";
}

export function localPartOf(value: string) {
  const first = value.trim().split(/\s+/)[0] ?? "";
  const clean = first.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[^a-z0-9]+/, "").slice(0, 40);
  return clean || "user";
}

function invitationHash(value: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("Invitation security is not configured");
  return createHmac("sha256", secret)
    .update(`organization-invitation:${value}`)
    .digest("hex");
}

/** `ACME-KEY-V7KD31M9Q2XA`: organization prefix + 12 unambiguous random characters (~60 bits). Security is the
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
  archivedAt: Date | null;
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
    archivedAt: invitation.archivedAt,
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
  /** Omitted: the organization's default role. */
  role?: Exclude<TenantRole, "OWNER">;
  expiresInHours?: number;
  maxUses?: number;
  groupIds?: string[];
  permissions?: Permission[];
};

async function validateIssue(
  tx: Transaction,
  actorId: string,
  organizationId: string,
  input: IssueInput & { role: Exclude<TenantRole, "OWNER"> },
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
  raw: IssueInput,
) {
  const policy = await readOrganizationPolicy(tx, organizationId);
  const input = { ...raw, role: raw.role ?? policy.defaultMemberRole };
  const validated = await validateIssue(tx, actorId, organizationId, input);
  // Groups the creator did not choose come from the organization's defaults, which its administrators already approved.
  const grants = { ...validated, groupIds: raw.groupIds === undefined ? policy.defaultGroupIds : validated.groupIds };
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
  list(userId: string, organizationId: string, archived = false) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "invitations.read");
      return (await repo.invitations(tx, organizationId, archived)).map(view);
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
    user: { id: string; email: string; emailVerified: boolean; createdByOrganizationId?: string | null },
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
      // An account an organization created (name@<slug>.bp, no real mailbox) belongs to that organization only.
      if (user.createdByOrganizationId && user.createdByOrganizationId !== invitation.organizationId)
        fail(403, "MANAGED_ACCOUNT_SINGLE_ORGANIZATION", "Accounts created by an organization cannot join another one");
      const emailed = invitation.kind === "EMAIL";
      if (emailed && normalizedEmail(user.email) !== invitation.email)
        fail(403, "INVITATION_EMAIL_MISMATCH", "The invitation belongs to another email");
      // An emailed invitation proves control of that mailbox (the token only exists in it); organization keys still need a verified account.
      if (!emailed && !user.emailVerified)
        fail(403, "VERIFIED_EMAIL_REQUIRED", "A verified email is required");
      if (emailed && !user.emailVerified) {
        await tx.user.update({ where: { id: user.id }, data: { emailVerified: true } });
        await tx.emailVerificationChallenge.deleteMany({ where: { userId: user.id } });
      }
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
      const invited = invitation.kind === "EMAIL" && invitation.email ? await repo.userByEmail(tx, invitation.email) : null;
      return {
        organization: { name: organization.name, slug: organization.slug, iconData: organization.iconData },
        kind: invitation.kind,
        expiresAt: invitation.expiresAt,
        // Only the holder of the emailed token can read these: they describe the recipient of that very invitation.
        email: invitation.kind === "EMAIL" ? invitation.email : null,
        accountExists: invitation.kind === "EMAIL" ? Boolean(invited) : null,
      };
    });
  },
  /**
   * Public: the recipient of an EMAIL invitation without an account chooses a name and a password and joins in one step.
   * The invitation token proves control of the mailbox, so the account is created already verified (no code is sent).
   */
  async acceptNew(credentialInput: string, input: { name: string; password: string }) {
    const credential = credentialInput.trim();
    const variants = [...new Set([credential, credential.toUpperCase()])];
    const hashes = variants.flatMap((value) => [invitationHash(value), legacyHash(value)]);
    const passwordHash = await hashPassword(input.password);
    try {
      return await transaction(async (tx) => {
        const invitation = await repo.invitation(tx, hashes);
        if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= new Date())
          fail(404, "INVITATION_INVALID", "Invitation unavailable");
        if (invitation.kind !== "EMAIL" || !invitation.email)
          fail(400, "INVITATION_EMAIL_REQUIRED", "Only emailed invitations can create an account");
        const organization = await repo.organization(tx, invitation.organizationId);
        if (!organization || organization.status !== "ACTIVE") fail(404, "INVITATION_INVALID", "Invitation unavailable");
        if (await repo.userByEmail(tx, invitation.email))
          fail(409, "ACCOUNT_EXISTS", "An account already exists for this email; sign in to accept");
        const user = await identities.create(tx, { name: input.name.trim(), email: invitation.email, role: "USER", emailVerified: true }, passwordHash);
        const membership = await repo.accept(tx, invitation.id, invitation.organizationId, user.id, invitation.role);
        if (!membership) fail(404, "INVITATION_INVALID", "Invitation unavailable");
        await repo.addInvitationGrants(
          tx,
          invitation.organizationId,
          membership.id,
          invitation.groupGrants.map((grant) => grant.groupId),
          invitation.permissionGrants.map((grant) => grant.permission).filter(isPermission),
        );
        await audit.append(tx, { actorId: user.id, organizationId: invitation.organizationId, action: "invitation.accept_new_account", targetType: "invitation", targetId: invitation.id, metadata: { kind: invitation.kind } });
        return { email: invitation.email, organization: { name: organization.name, slug: organization.slug } };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        fail(409, "ACCOUNT_EXISTS", "An account already exists for this email; sign in to accept");
      throw error;
    }
  },
  /**
   * An organization administrator creates a member account: name, a login address name@<org>.bp assigned automatically
   * (the domain is the organization's own slug, so an admin can never mint addresses of another organization) and a password
   * they type or have generated (ORG-PASS-<10 chars>). The generated password is returned once and never stored or audited.
   */
  async createMember(
    userId: string,
    organizationId: string,
    raw: { name: string; localPart?: string; password?: string; role?: Exclude<TenantRole, "OWNER">; groupIds?: string[]; templateId?: string; primaryGroupId?: string },
  ) {
    const slug = (await transaction((tx) => repo.organization(tx, organizationId)))?.slug ?? "org";
    const policy = await transaction((tx) => readOrganizationPolicy(tx, organizationId));
    const template = raw.templateId ? await transaction((tx) => loadTemplate(tx, organizationId, raw.templateId!)) : null;
    const input = { ...raw, role: raw.role ?? (template?.role as Exclude<TenantRole, "OWNER"> | undefined) ?? policy.defaultMemberRole };
    const generated = input.password ? null : generatedPassword(slug);
    const password = input.password ?? generated!;
    const passwordHash = await hashPassword(password);
    try {
      return await transaction(async (tx) => {
        const actor = await authorize(tx, userId, organizationId, "members.manage");
        if (!canManageRole(actor.role, input.role, input.role)) fail(403, "FORBIDDEN", "Cannot assign this role");
        const groupIds = [...new Set(input.groupIds ?? (template ? template.groupIds : policy.defaultGroupIds))];
        if (input.groupIds?.length) await authorize(tx, userId, organizationId, "permissions.manage");
        const found = [];
        for (const groupId of groupIds) { const group = await groups.group(tx, organizationId, groupId); if (!group) fail(404, "NOT_FOUND", "Group not found"); found.push(group); }
        if (input.primaryGroupId && !groupIds.includes(input.primaryGroupId)) fail(422, "PRIMARY_GROUP_NOT_ASSIGNED", "The primary group must be one of the account's groups");
        const primary = input.primaryGroupId ? found.find((group) => group.id === input.primaryGroupId) : undefined;
        const organization = await repo.organization(tx, organizationId);
        if (!organization || organization.status !== "ACTIVE") fail(404, "NOT_FOUND", "Organization not found");
        const domain = organizationDomain(organization.slug);
        const base = localPartOf(input.localPart ?? input.name);
        // Alias: name@org.bp, or name.group@org.bp when a primary group is chosen. It is the login, so it is fixed at creation.
        const addressOf = (name: string) => (primary ? `${name}.${groupAliasSlug(primary.name)}@${domain}` : `${name}@${domain}`);
        let email = addressOf(base);
        if (input.localPart) {
          if (await repo.userByEmail(tx, email)) fail(409, "IDENTITY_EXISTS", "That address is already taken");
        } else {
          for (let n = 2; await repo.userByEmail(tx, email); n += 1) email = addressOf(`${base}${n}`);
        }
        const user = await identities.create(tx, { name: input.name.trim(), email, role: "USER", emailVerified: true, createdByOrganizationId: organizationId }, passwordHash);
        const membership = await repo.addMember(tx, organizationId, user.id, input.role);
        await repo.addInvitationGrants(tx, organizationId, membership.id, groupIds, []);
        if (primary) await tx.organizationGroupMember.update({ where: { groupId_membershipId: { groupId: primary.id, membershipId: membership.id } }, data: { isPrimary: true } });
        const applied = template ? await applyTemplateToMembership(tx, userId, organizationId, membership.id, template, { groups: false }) : null;
        await audit.append(tx, { actorId: userId, organizationId, action: "membership.create_user", targetType: "membership", targetId: membership.id, metadata: { role: input.role, passwordGenerated: Boolean(generated), groupCount: groupIds.length, ...(template ? { templateId: template.id, datasets: applied?.datasets ?? 0 } : {}), ...(primary ? { primaryGroupId: primary.id } : {}) } });
        return { membership, user: { id: user.id, email, name: input.name.trim() }, password: generated };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") fail(409, "IDENTITY_EXISTS", "That address is already taken");
      throw error;
    }
  },
  /** Org admins check whether an account already exists for an email (needs members.manage). */
  lookupUser(userId: string, organizationId: string, emailInput: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "members.manage");
      const found = await repo.userByEmail(tx, normalizedEmail(emailInput));
      if (!found || found.status !== "ACTIVE" || (found.createdByOrganizationId && found.createdByOrganizationId !== organizationId)) return { exists: false as const, user: null, alreadyMember: false };
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
    raw: { email: string; role?: Exclude<TenantRole, "OWNER">; groupIds?: string[]; templateId?: string; primaryGroupId?: string },
  ) {
    return transaction(async (tx) => {
      const actor = await authorize(tx, userId, organizationId, "members.manage");
      const policy = await readOrganizationPolicy(tx, organizationId);
      const template = raw.templateId ? await loadTemplate(tx, organizationId, raw.templateId) : null;
      const input = { ...raw, role: raw.role ?? (template?.role as Exclude<TenantRole, "OWNER"> | undefined) ?? policy.defaultMemberRole };
      if (!canManageRole(actor.role, input.role, input.role))
        fail(403, "FORBIDDEN", "Cannot assign this role");
      const groupIds = [...new Set(input.groupIds ?? (template ? template.groupIds : policy.defaultGroupIds))];
      if (input.groupIds?.length) await authorize(tx, userId, organizationId, "permissions.manage");
      for (const groupId of groupIds)
        if (!(await groups.group(tx, organizationId, groupId)))
          fail(404, "NOT_FOUND", "Group not found");
      if (input.primaryGroupId && !groupIds.includes(input.primaryGroupId)) fail(422, "PRIMARY_GROUP_NOT_ASSIGNED", "The primary group must be one of the account's groups");
      const target = await repo.userByEmail(tx, normalizedEmail(input.email));
      if (!target || target.status !== "ACTIVE" || !target.emailVerified || (target.createdByOrganizationId && target.createdByOrganizationId !== organizationId))
        fail(404, "USER_NOT_FOUND", "No verified account exists for this email");
      if (await repo.membership(tx, organizationId, target.id))
        fail(409, "ALREADY_MEMBER", "The user already belongs to this organization");
      const membership = await repo.addMember(tx, organizationId, target.id, input.role);
      await repo.addInvitationGrants(tx, organizationId, membership.id, groupIds, []);
      if (input.primaryGroupId) await tx.organizationGroupMember.update({ where: { groupId_membershipId: { groupId: input.primaryGroupId, membershipId: membership.id } }, data: { isPrimary: true } });
      if (template) await applyTemplateToMembership(tx, userId, organizationId, membership.id, template, { groups: false });
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
  /** Archive hides a finished invitation (revoked, expired or accepted) from the working list; pending ones must be revoked first. */
  archive(userId: string, organizationId: string, invitationId: string, archived: boolean) {
    return transaction(async (tx) => {
      const actor = await authorize(tx, userId, organizationId, "invitations.manage");
      const invitation = await repo.invitationById(tx, invitationId, organizationId);
      if (!invitation) fail(404, "NOT_FOUND", "Invitation not found");
      if (!canManageRole(actor.role, invitation.role)) fail(403, "FORBIDDEN", "Cannot manage this invitation");
      if (archived && invitationStatus(invitation) === "PENDING") fail(409, "INVITATION_PENDING", "Revoke a pending invitation before archiving it");
      if (Boolean(invitation.archivedAt) !== archived) await repo.setArchived(tx, invitationId, archived ? new Date() : null);
      await audit.append(tx, { actorId: userId, organizationId, action: archived ? "invitation.archive" : "invitation.restore", targetType: "invitation", targetId: invitationId });
    });
  },
  /** Permanent removal is only for credentials that were never used: revoked or expired, never accepted. Accepted invitations are history. */
  deletePermanently(userId: string, organizationId: string, invitationId: string) {
    return transaction(async (tx) => {
      const actor = await authorize(tx, userId, organizationId, "invitations.manage");
      const invitation = await repo.invitationById(tx, invitationId, organizationId);
      if (!invitation) fail(404, "NOT_FOUND", "Invitation not found");
      if (!canManageRole(actor.role, invitation.role)) fail(403, "FORBIDDEN", "Cannot manage this invitation");
      const status = invitationStatus(invitation);
      if (invitation.acceptedAt || invitation.useCount > 0 || status === "ACCEPTED") fail(409, "INVITATION_ACCEPTED", "Accepted invitations are part of the membership history");
      if (status === "PENDING") fail(409, "INVITATION_PENDING", "Revoke a pending invitation before deleting it");
      await repo.deleteInvitation(tx, invitationId);
      await audit.append(tx, { actorId: userId, organizationId, action: "invitation.delete", targetType: "invitation", targetId: invitationId, metadata: { kind: invitation.kind, status } });
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
