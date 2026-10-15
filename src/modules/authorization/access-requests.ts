import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { isPermission, type Permission } from "./policy.js";
import { authorize, resolvePermissions } from "./service.js";
import { groupsRepository as groupsRepo } from "./groups-repository.js";

const MAX_OPEN_PER_MEMBER = 5;
const DAY = 86_400_000;

const view = (row: { id: string; organizationId: string; membershipId: string; permission: string; reason: string; requestedDays: number | null; status: string; decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null; grantExpiresAt: Date | null; createdAt: Date; membership?: { userId: string; user: { name: string | null; email: string } } }) => ({
  id: row.id, permission: row.permission as Permission, reason: row.reason, requestedDays: row.requestedDays, status: row.status as "PENDING" | "APPROVED" | "DENIED" | "CANCELLED",
  decidedBy: row.decidedBy, decidedAt: row.decidedAt, decisionNote: row.decisionNote, grantExpiresAt: row.grantExpiresAt, createdAt: row.createdAt,
  requester: row.membership ? { userId: row.membership.userId, name: row.membership.user.name, email: row.membership.user.email.trim().toLowerCase() } : null,
});
const include = { membership: { select: { userId: true, user: { select: { name: true, email: true } } } } } as const;

async function member(tx: Transaction, userId: string, organizationId: string) {
  const resolved = await resolvePermissions(tx, userId, organizationId);
  if (resolved.inspection) fail(403, "FORBIDDEN", "Platform inspection cannot request access");
  return resolved;
}

/**
 * Access requests: a member asks for one registered permission with a reason; whoever holds `permissions.manage` approves
 * (optionally for a limited number of days) or denies. Approval writes the same direct grant an administrator could write by
 * hand, so every existing authorization check applies unchanged. Nobody approves their own request, and nobody grants what
 * they do not hold themselves.
 */
export const accessRequests = {
  create(userId: string, organizationId: string, input: { permission: string; reason: string; days?: number }) {
    return transaction(async (tx) => {
      const resolved = await member(tx, userId, organizationId);
      if (!isPermission(input.permission)) fail(422, "UNKNOWN_PERMISSION", "Permission is not registered");
      if (resolved.permissions.includes(input.permission)) fail(409, "ALREADY_ALLOWED", "You already have this permission");
      const open = await tx.accessRequest.count({ where: { membershipId: resolved.member.id, status: "PENDING" } });
      if (open >= MAX_OPEN_PER_MEMBER) fail(429, "TOO_MANY_OPEN_REQUESTS", "Too many open requests; wait for a decision or cancel one");
      let created;
      try {
        created = await tx.accessRequest.create({ data: { organizationId, membershipId: resolved.member.id, permission: input.permission, reason: input.reason.trim(), requestedDays: input.days ?? null }, include });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") fail(409, "REQUEST_ALREADY_OPEN", "There is already an open request for this permission");
        throw error;
      }
      await audit.append(tx, { actorId: userId, organizationId, action: "access.request.create", targetType: "AccessRequest", targetId: created.id, metadata: { permission: input.permission, days: input.days ?? null } });
      return view(created);
    });
  },

  /** `mine` needs only membership; the organization-wide queue needs permissions.manage. */
  list(userId: string, organizationId: string, scope: "mine" | "all", status?: "PENDING" | "APPROVED" | "DENIED" | "CANCELLED") {
    return transaction(async (tx) => {
      const resolved = await member(tx, userId, organizationId);
      if (scope === "all" && !resolved.permissions.includes("permissions.manage")) fail(403, "FORBIDDEN", "Permission denied");
      const rows = await tx.accessRequest.findMany({
        where: { organizationId, ...(scope === "mine" ? { membershipId: resolved.member.id } : {}), ...(status ? { status } : {}) },
        include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
      });
      return rows.map(view);
    });
  },

  cancel(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      const resolved = await member(tx, userId, organizationId);
      const changed = await tx.accessRequest.updateMany({ where: { id, organizationId, membershipId: resolved.member.id, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
      if (changed.count !== 1) fail(404, "NOT_FOUND", "Open request not found");
      await audit.append(tx, { actorId: userId, organizationId, action: "access.request.cancel", targetType: "AccessRequest", targetId: id });
      return null;
    });
  },

  decide(userId: string, organizationId: string, id: string, input: { decision: "APPROVE" | "DENY"; note?: string; days?: number | null }) {
    return transaction(async (tx) => {
      const actor = await authorize(tx, userId, organizationId, "permissions.manage");
      const resolved = await resolvePermissions(tx, userId, organizationId);
      const request = await tx.accessRequest.findFirst({ where: { id, organizationId }, include });
      if (!request) fail(404, "NOT_FOUND", "Request not found");
      if (request.membershipId === actor.id) fail(403, "SELF_APPROVAL", "You cannot decide your own request");
      if (input.decision === "APPROVE" && !resolved.permissions.includes(request.permission as Permission))
        fail(403, "PRIVILEGE_ESCALATION", "You cannot grant a permission you do not hold");
      // Days: explicit value wins (null = permanent), otherwise what the member asked for, otherwise permanent.
      const days = input.days === undefined ? request.requestedDays : input.days;
      const expiresAt = input.decision === "APPROVE" && days ? new Date(Date.now() + days * DAY) : null;
      const claimed = await tx.accessRequest.updateMany({
        where: { id, organizationId, status: "PENDING" },
        data: { status: input.decision === "APPROVE" ? "APPROVED" : "DENIED", decidedBy: userId, decidedAt: new Date(), decisionNote: input.note?.trim() || null, grantExpiresAt: expiresAt },
      });
      if (claimed.count !== 1) fail(409, "ALREADY_DECIDED", "This request was already decided");
      if (input.decision === "APPROVE") await groupsRepo.grantDirect(tx, organizationId, request.membershipId, request.permission, { expiresAt, grantedBy: userId });
      await audit.append(tx, { actorId: userId, organizationId, action: input.decision === "APPROVE" ? "access.request.approve" : "access.request.deny", targetType: "AccessRequest", targetId: id, metadata: { permission: request.permission, expiresAt: expiresAt?.toISOString() ?? null } });
      return view((await tx.accessRequest.findUniqueOrThrow({ where: { id }, include })));
    });
  },
};

/** Removes grants whose time is up (enforcement already ignores them) and leaves one audit row per organization. */
export async function purgeExpiredGrants() {
  const { prisma } = await import("../../lib/database.js");
  const expired = await prisma.membershipPermissionGrant.groupBy({ by: ["organizationId"], where: { expiresAt: { lte: new Date() } }, _count: true });
  let removed = 0;
  for (const entry of expired) {
    await transaction(async (tx) => {
      const result = await tx.membershipPermissionGrant.deleteMany({ where: { organizationId: entry.organizationId, expiresAt: { lte: new Date() } } });
      if (result.count) await audit.append(tx, { organizationId: entry.organizationId, action: "authorization.member.permission.expired", targetType: "organization", targetId: entry.organizationId, metadata: { count: result.count } });
      removed += result.count;
    });
  }
  return removed;
}
