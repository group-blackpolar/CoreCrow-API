import { Prisma, type OrganizationStatus, type TenantRole } from "../../lib/database.js";
import { transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { tenantRepository as repo } from "./repository.js";
import { authorize } from "../authorization/service.js";
import { canManageRole } from "../authorization/policy.js";
import { auditRepository as audit } from "../audit/repository.js";
import {
  isReservedOrganizationSlug,
  normalizeOrganizationSlug,
} from "./slug.js";
import { bootstrapNorthOrganization } from "../north/service.js";
import { assetConfiguration } from "../north/asset-config.js";

function validSlug(input: string) {
  const slug = normalizeOrganizationSlug(input);
  if (slug.length < 2)
    fail(400, "ORGANIZATION_SLUG_INVALID", "Organization slug is invalid");
  if (isReservedOrganizationSlug(slug))
    fail(409, "ORGANIZATION_SLUG_RESERVED", "Organization slug is reserved");
  return slug;
}

function slugConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
export const tenants = {
  list: repo.list,
  async create(userId: string, data: { name: string; slug?: string }) {
    const slug = validSlug(data.slug ?? data.name);
    try {
      return await transaction(async (tx) => {
        const org = await repo.create(tx, userId, {
          name: data.name,
          slug,
          storageLimitBytes: BigInt(assetConfiguration().defaultOrganizationStorageLimitBytes),
        });
        await bootstrapNorthOrganization(tx, org.id);
        await audit.append(tx, {
          actorId: userId,
          organizationId: org.id,
          action: "organization.create",
          targetType: "organization",
          targetId: org.id,
          metadata: { slug },
        });
        return org;
      });
    } catch (error) {
      if (slugConflict(error))
        fail(409, "ORGANIZATION_SLUG_TAKEN", "Organization slug is unavailable");
      throw error;
    }
  },
  async resolvePublic(slugInput: string) {
    const slug = normalizeOrganizationSlug(slugInput);
    const organization = await repo.publicOrganization(slug);
    if (!organization) fail(404, "NOT_FOUND", "Organization not found");
    return organization;
  },
  read(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "organization.read");
      return repo.organization(tx, organizationId);
    });
  },
  async update(
    userId: string,
    organizationId: string,
    data: { name?: string; slug?: string },
  ) {
    const update = {
      ...(data.name ? { name: data.name } : {}),
      ...(data.slug ? { slug: validSlug(data.slug) } : {}),
    };
    try {
      return await transaction(async (tx) => {
        await authorize(tx, userId, organizationId, "organization.update");
        const current = await repo.organization(tx, organizationId);
        if (!current) fail(404, "NOT_FOUND", "Organization not found");
        if (current.status !== "ACTIVE")
          fail(409, "ORGANIZATION_INACTIVE", "Organization is not active");
        const org = await repo.update(tx, organizationId, update);
        await audit.append(tx, {
          actorId: userId,
          organizationId,
          action: "organization.update",
          targetType: "organization",
          targetId: organizationId,
          metadata: { fields: Object.keys(update).sort() },
        });
        return org;
      });
    } catch (error) {
      if (slugConflict(error))
        fail(409, "ORGANIZATION_SLUG_TAKEN", "Organization slug is unavailable");
      throw error;
    }
  },
  setStatus(
    userId: string,
    organizationId: string,
    status: Extract<OrganizationStatus, "ACTIVE" | "ARCHIVED">,
  ) {
    return transaction(async (tx) => {
      const actor = await authorize(
        tx,
        userId,
        organizationId,
        "organization.update",
      );
      if (actor.role !== "OWNER")
        fail(403, "FORBIDDEN", "Only an owner can change organization lifecycle");
      const current = await repo.organization(tx, organizationId);
      if (!current) fail(404, "NOT_FOUND", "Organization not found");
      if (current.status === "SUSPENDED")
        fail(
          409,
          "ORGANIZATION_SUSPENDED",
          "A suspended organization requires platform administration",
        );
      const org = await repo.update(tx, organizationId, { status });
      await audit.append(tx, {
        actorId: userId,
        organizationId,
        action: status === "ARCHIVED" ? "organization.archive" : "organization.restore",
        targetType: "organization",
        targetId: organizationId,
        metadata: { previousStatus: current.status, status },
      });
      return org;
    });
  },
  members(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "members.read");
      return repo.members(tx, organizationId);
    });
  },
  changeMember(
    userId: string,
    organizationId: string,
    targetUserId: string,
    role?: TenantRole,
  ) {
    return transaction(async (tx) => {
      const actor = await authorize(
        tx,
        userId,
        organizationId,
        "members.manage",
      );
      const target = await repo.membership(tx, organizationId, targetUserId);
      if (!target) fail(404, "NOT_FOUND", "Member not found");
      if (!canManageRole(actor.role, target.role, role))
        fail(403, "FORBIDDEN", "Cannot manage this role");
      if (
        target.role === "OWNER" &&
        role !== "OWNER" &&
        (await repo.owners(tx, organizationId)) <= 1
      )
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
};
