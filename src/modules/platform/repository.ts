import type { AccountStatus, OrganizationStatus } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
import { publicUser } from "../identity/repository.js";

const userSearch = (query?: string) =>
  query
    ? {
        OR: [
          { email: { contains: query, mode: "insensitive" as const } },
          { name: { contains: query, mode: "insensitive" as const } },
        ],
      }
    : {};

export const platformRepository = {
  users(tx: Transaction, query: { q?: string; limit: number; cursor?: string }) {
    return tx.user.findMany({
      where: userSearch(query.q),
      select: publicUser,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
  },
  user(tx: Transaction, id: string) {
    return tx.user.findUnique({
      where: { id },
      select: {
        ...publicUser,
        memberships: {
          orderBy: { createdAt: "asc" },
          take: 100,
          select: {
            id: true,
            role: true,
            createdAt: true,
            organization: {
              select: { id: true, name: true, slug: true, status: true },
            },
          },
        },
      },
    });
  },
  organizations(
    tx: Transaction,
    query: { q?: string; limit: number; cursor?: string },
  ) {
    return tx.organization.findMany({
      where: query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { slug: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {},
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { memberships: true, groups: true } },
        billingProfile: {
          select: { status: true, currency: true },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
  },
  organization(tx: Transaction, id: string) {
    return tx.organization.findUnique({
      where: { id },
      include: {
        memberships: {
          orderBy: { createdAt: "asc" },
          take: 100,
          select: {
            id: true,
            role: true,
            createdAt: true,
            user: { select: publicUser },
          },
        },
        groups: {
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: 100,
          select: {
            id: true,
            organizationId: true,
            name: true,
            description: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { memberships: true, permissionGrants: true } },
          },
        },
        billingProfile: true,
        _count: { select: { invitations: true } },
      },
    });
  },
  setUserStatus(tx: Transaction, id: string, status: AccountStatus) {
    return tx.user.update({ where: { id }, data: { status }, select: publicUser });
  },
  revokeSessions(tx: Transaction, userId: string) {
    return tx.session.deleteMany({ where: { userId } });
  },
  setOrganizationStatus(
    tx: Transaction,
    id: string,
    status: OrganizationStatus,
  ) {
    return tx.organization.update({ where: { id }, data: { status } });
  },
};
