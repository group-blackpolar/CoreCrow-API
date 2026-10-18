import { Prisma } from "../../../lib/database.js";
import { DomainError, fail } from "../../../shared/errors.js";
import { transaction, type Transaction } from "../../../shared/transaction.js";
import { auditRepository as audit } from "../../audit/repository.js";
import { validateNorthSlug } from "../slug.js";
import { authorizeDataset, datasetAclAllows, hasOrganizationDataCapability, requireOrganizationDataCapability } from "./authorization.js";
import { northDataRepository as repo } from "./repository.js";
import type { Localized } from "./types.js";

export type GroupInput = {
  slug: string;
  name: Localized;
  description?: Localized | null;
  category?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
};
export type GroupUpdate = Partial<GroupInput> & { status?: "ACTIVE" | "ARCHIVED" };
export type PeriodInput = { periodStart?: string | null; periodEnd?: string | null; periodLabel?: string | null };

const FAILED_IMPORTS = ["FAILED", "REJECTED", "SECURITY_BLOCKED", "ANALYSIS_BLOCKED"];
const day = (value: string | null | undefined) => (value ? new Date(`${value}T00:00:00.000Z`) : value);
const isoDay = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

function conflict(error: unknown): never {
  if (typeof error === "object" && error && (error as { code?: string }).code === "P2002")
    fail(409, "DATASET_GROUP_CONFLICT", "A dataset group with this slug already exists");
  throw error;
}

function groupSlug(value: string) {
  const result = validateNorthSlug(value, false);
  if (result.error) fail(result.error === "NORTH_SLUG_RESERVED" ? 409 : 422, result.error, "Dataset group slug is unavailable");
  return result.slug;
}

async function loadGroup(tx: Transaction, organizationId: string, groupId: string) {
  const group = await tx.northDatasetGroup.findFirst({ where: { id: groupId, organizationId } });
  if (!group) fail(404, "NOT_FOUND", "Dataset group not found");
  return group;
}

/** Datasets of the group the caller may see (same ACL and archive rules as the dataset list); the summary never counts hidden ones. */
async function visibleMembers(tx: Transaction, organizationId: string, groupIds: string[], membership: Parameters<typeof datasetAclAllows>[1]) {
  const inspectArchived = await hasOrganizationDataCapability(tx, membership, "north.data.manage");
  const candidates = await tx.northDataset.findMany({
    where: { organizationId, groupId: { in: groupIds }, ...(inspectArchived ? {} : { status: "ACTIVE" }) },
    include: { activeRevision: { select: { rowCount: true } } },
    orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 2000,
  });
  const visible = [];
  for (const dataset of candidates)
    if (await datasetAclAllows(tx, membership, await repo.aclRules(tx, organizationId, dataset.id))) visible.push(dataset);
  return visible;
}

async function summarize(tx: Transaction, organizationId: string, members: Awaited<ReturnType<typeof visibleMembers>>) {
  const ids = members.map((dataset) => dataset.id);
  const [sizes, latest] = ids.length
    ? await Promise.all([
        tx.northDatasetImportJob.groupBy({ by: ["datasetId"], where: { organizationId, datasetId: { in: ids }, status: "SUCCEEDED" }, _sum: { declaredSize: true }, _max: { completedAt: true } }),
        tx.northDatasetImportJob.findMany({ where: { organizationId, datasetId: { in: ids } }, distinct: ["datasetId"], orderBy: [{ datasetId: "asc" }, { createdAt: "desc" }], select: { datasetId: true, status: true } }),
      ])
    : [[], []];
  const sizeBy = new Map(sizes.map((row) => [row.datasetId, row]));
  const failing = new Set(latest.filter((job) => FAILED_IMPORTS.includes(job.status)).map((job) => job.datasetId));
  const starts = members.flatMap((dataset) => (dataset.periodStart ? [dataset.periodStart.getTime()] : []));
  const ends = members.flatMap((dataset) => (dataset.periodEnd ? [dataset.periodEnd.getTime()] : []));
  const lastImports = sizes.flatMap((row) => (row._max.completedAt ? [row._max.completedAt.getTime()] : []));
  return {
    datasetCount: members.length,
    rowCount: members.reduce((sum, dataset) => sum + (dataset.activeRevision?.rowCount ?? 0), 0),
    originalBytes: sizes.reduce((sum, row) => sum + Number(row._sum.declaredSize ?? 0n), 0),
    periodStart: starts.length ? isoDay(new Date(Math.min(...starts))) : null,
    periodEnd: ends.length ? isoDay(new Date(Math.max(...ends))) : null,
    lastImportAt: lastImports.length ? new Date(Math.max(...lastImports)).toISOString() : null,
    datasetsWithIssues: members.filter((dataset) => failing.has(dataset.id)).length,
    health: members.length === 0 ? "EMPTY" : members.some((dataset) => failing.has(dataset.id)) ? "ISSUES" : "OK",
    sizes: (id: string) => ({ originalBytes: Number(sizeBy.get(id)?._sum.declaredSize ?? 0n) }),
  };
}

type GroupRow = Awaited<ReturnType<typeof loadGroup>>;
function present(group: GroupRow, summary: Awaited<ReturnType<typeof summarize>>) {
  const { sizes: _sizes, ...rest } = summary;
  return { ...group, metadata: group.metadata as Record<string, unknown>, summary: rest };
}

function presentDataset(dataset: Awaited<ReturnType<typeof visibleMembers>>[number], summary: Awaited<ReturnType<typeof summarize>>) {
  return {
    id: dataset.id, slug: dataset.slug, name: dataset.name as Localized, status: dataset.status, groupId: dataset.groupId,
    periodStart: isoDay(dataset.periodStart), periodEnd: isoDay(dataset.periodEnd), periodLabel: dataset.periodLabel,
    rowCount: dataset.activeRevision?.rowCount ?? 0, originalBytes: summary.sizes(dataset.id).originalBytes, updatedAt: dataset.updatedAt.toISOString(),
  };
}

export const northDatasetGroups = {
  list(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      const membership = await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.read");
      const mayInspectArchived = await hasOrganizationDataCapability(tx, membership, "north.data.manage");
      const groups = await tx.northDatasetGroup.findMany({
        where: { organizationId, ...(mayInspectArchived ? {} : { status: "ACTIVE" }) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 200,
      });
      const members = await visibleMembers(tx, organizationId, groups.map((group) => group.id), membership);
      const result = [];
      for (const group of groups) result.push(present(group, await summarize(tx, organizationId, members.filter((dataset) => dataset.groupId === group.id))));
      return result;
    });
  },

  read(userId: string, organizationId: string, groupId: string) {
    return transaction(async (tx) => {
      const membership = await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.read");
      const group = await loadGroup(tx, organizationId, groupId);
      if (group.status === "ARCHIVED" && !(await hasOrganizationDataCapability(tx, membership, "north.data.manage")))
        fail(404, "NOT_FOUND", "Dataset group not found");
      const members = await visibleMembers(tx, organizationId, [groupId], membership);
      const summary = await summarize(tx, organizationId, members);
      return { ...present(group, summary), datasets: members.map((dataset) => presentDataset(dataset, summary)) };
    });
  },

  create(userId: string, organizationId: string, input: GroupInput) {
    return transaction(async (tx) => {
      await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.manage");
      try {
        const group = await tx.northDatasetGroup.create({ data: {
          organizationId, ownerId: userId, slug: groupSlug(input.slug), name: input.name,
          description: input.description ?? undefined, category: input.category ?? null, tags: input.tags ?? [],
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        } });
        await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_DATASET_GROUP_CREATED", targetType: "NorthDatasetGroup", targetId: group.id, metadata: { groupId: group.id, slug: group.slug } });
        return present(group, await summarize(tx, organizationId, []));
      } catch (error) { return conflict(error); }
    });
  },

  update(userId: string, organizationId: string, groupId: string, input: GroupUpdate) {
    return transaction(async (tx) => {
      const membership = await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.manage");
      const before = await loadGroup(tx, organizationId, groupId);
      try {
        const group = await tx.northDatasetGroup.update({ where: { id: groupId }, data: {
          ...(input.slug !== undefined ? { slug: groupSlug(input.slug) } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? Prisma.JsonNull } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        } });
        const action = input.status && input.status !== before.status ? (input.status === "ARCHIVED" ? "NORTH_DATASET_GROUP_ARCHIVED" : "NORTH_DATASET_GROUP_RESTORED") : "NORTH_DATASET_GROUP_UPDATED";
        await audit.append(tx, { actorId: userId, organizationId, action, targetType: "NorthDatasetGroup", targetId: groupId, metadata: { groupId, changed: Object.keys(input) } });
        const members = await visibleMembers(tx, organizationId, [groupId], membership);
        return present(group, await summarize(tx, organizationId, members));
      } catch (error) { return conflict(error); }
    });
  },

  /**
   * Put a dataset in a group (or take it out with groupId null) and set its period. Overlapping periods inside a
   * group are refused unless the caller acknowledges them, because overlap is the usual cause of double counting.
   */
  assign(userId: string, organizationId: string, datasetId: string, input: PeriodInput & { groupId: string | null; allowOverlap?: boolean }) {
    return transaction(async (tx) => {
      const { dataset } = await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      const start = day(input.periodStart) ?? null;
      const end = day(input.periodEnd) ?? null;
      if (start && end && end < start) fail(422, "PERIOD_INVALID", "Period end is before its start");
      if (input.groupId) {
        const group = await loadGroup(tx, organizationId, input.groupId);
        if (group.status !== "ACTIVE") fail(409, "DATASET_GROUP_ARCHIVED", "Restore the group before adding datasets");
        if (start && end && !input.allowOverlap) {
          const overlaps = (await tx.northDataset.findMany({
            where: { organizationId, groupId: input.groupId, id: { not: datasetId }, status: "ACTIVE", periodStart: { lte: end }, periodEnd: { gte: start } },
            select: { id: true, slug: true, periodStart: true, periodEnd: true }, take: 20,
          })).map((row) => ({ id: row.id, slug: row.slug, periodStart: isoDay(row.periodStart), periodEnd: isoDay(row.periodEnd) }));
          if (overlaps.length) throw new DomainError(409, "PERIOD_OVERLAP", "The period overlaps other datasets of the group", { overlaps: overlaps.length, slugs: overlaps.map((row) => row.slug).join(",") });
        }
      }
      const updated = await tx.northDataset.update({ where: { id: datasetId }, data: { groupId: input.groupId, periodStart: start, periodEnd: end, periodLabel: input.periodLabel ?? null } });
      await audit.append(tx, {
        actorId: userId, organizationId, action: input.groupId ? "NORTH_DATASET_GROUP_ASSIGNED" : "NORTH_DATASET_GROUP_REMOVED", targetType: "NorthDataset", targetId: datasetId,
        metadata: { datasetId, groupId: input.groupId ?? dataset.groupId, previousGroupId: dataset.groupId, periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null },
      });
      return { id: updated.id, groupId: updated.groupId, periodStart: isoDay(updated.periodStart), periodEnd: isoDay(updated.periodEnd), periodLabel: updated.periodLabel };
    });
  },

  /** Exact scope of a delete, shown before confirming: members are detached, never erased; bindings are reported. */
  dependencies(userId: string, organizationId: string, groupId: string) {
    return transaction(async (tx) => {
      await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.manage");
      await loadGroup(tx, organizationId, groupId);
      return groupDependencies(tx, organizationId, groupId);
    });
  },

  /** Deletes only the logical group. Datasets, their data and files are untouched (they become standalone). Archive first. */
  delete(userId: string, organizationId: string, groupId: string, input: { detachDatasets: boolean }) {
    return transaction(async (tx) => {
      await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.manage");
      const group = await loadGroup(tx, organizationId, groupId);
      if (group.status !== "ARCHIVED") fail(409, "DATASET_GROUP_NOT_ARCHIVED", "Archive the group before deleting it");
      const dependencies = await groupDependencies(tx, organizationId, groupId);
      if (dependencies.datasets > 0 && !input.detachDatasets)
        throw new DomainError(409, "DATASET_GROUP_NOT_EMPTY", "The group still has datasets; move them or confirm detaching them", dependencies);
      if (dependencies.runningImports > 0) fail(409, "DATASET_IMPORT_RUNNING", "Wait for running imports to finish or cancel them");
      await tx.northDataset.updateMany({ where: { organizationId, groupId }, data: { groupId: null } });
      await tx.northDatasetGroup.delete({ where: { id: groupId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_DATASET_GROUP_DELETED", targetType: "NorthDatasetGroup", targetId: groupId, metadata: { groupId, slug: group.slug, detachedDatasets: dependencies.datasets } });
      return null;
    });
  },

  /** Group-level audit trail: events targeting the group and events of its datasets that carry the group id. */
  async audit(userId: string, organizationId: string, groupId: string, query: { limit: number; before?: Date }) {
    return transaction(async (tx) => {
      await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.manage");
      await loadGroup(tx, organizationId, groupId);
      const rows = await tx.auditLog.findMany({
        where: { organizationId, ...(query.before ? { createdAt: { lt: query.before } } : {}), OR: [{ targetType: "NorthDatasetGroup", targetId: groupId }, { metadata: { path: ["groupId"], equals: groupId } }] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit,
        select: { id: true, action: true, actorId: true, targetType: true, targetId: true, requestId: true, metadata: true, createdAt: true },
      });
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), metadata: (row.metadata ?? {}) as Record<string, unknown> }));
    });
  },
};

async function groupDependencies(tx: Transaction, organizationId: string, groupId: string) {
  const datasets = await tx.northDataset.findMany({ where: { organizationId, groupId }, select: { id: true } });
  const ids = datasets.map((dataset) => dataset.id);
  const [bindings, runningImports] = ids.length
    ? await Promise.all([
        tx.northAnalyticsBinding.findMany({ where: { organizationId, datasetId: { in: ids } }, select: { panelId: true } }),
        tx.northDatasetImportJob.count({ where: { organizationId, datasetId: { in: ids }, status: { in: ["ANALYZING", "ACTIVATING", "SECURITY_PENDING", "CANCEL_REQUESTED"] } } }),
      ])
    : [[], 0];
  return { datasets: ids.length, bindings: bindings.length, panels: new Set(bindings.map((binding) => binding.panelId)).size, runningImports };
}
