import { transaction, type Transaction } from "../../shared/transaction.js";
import { authorize } from "../authorization/service.js";
import { fail } from "../../shared/errors.js";

/** Import jobs whose source file is not kept (or never arrived) do not count against the organization's storage. */
const RELEASED_IMPORT_STATUSES = ["CANCELLED", "REJECTED", "FAILED", "SECURITY_BLOCKED", "ANALYSIS_BLOCKED"] as const;

export type StorageUsage = {
  limitBytes: bigint;
  assetBytes: bigint;
  reservedBytes: bigint;
  importBytes: bigint;
  usedBytes: bigint;
  assetCount: number;
  importCount: number;
  byCategory: Array<{ category: "image" | "video" | "document" | "other"; bytes: bigint; count: number }>;
};

const categoryOf = (mime: string): "image" | "video" | "document" | "other" =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime === "application/pdf" || mime.startsWith("text/") || mime.includes("document") || mime.includes("sheet") ? "document" : "other";

/** One organization's storage: assets (plus uploads in flight) and the source files of dataset imports, against its limit. */
export async function organizationStorage(tx: Transaction, organizationId: string): Promise<StorageUsage> {
  const organization = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { storageLimitBytes: true, storageUsedBytes: true, storageReservedBytes: true },
  });
  if (!organization) fail(404, "NOT_FOUND", "Organization not found");
  const [imports, assets] = await Promise.all([
    tx.northDatasetImportJob.aggregate({ where: { organizationId, status: { notIn: [...RELEASED_IMPORT_STATUSES] } }, _sum: { declaredSize: true }, _count: true }),
    tx.northAsset.groupBy({ by: ["mime"], where: { organizationId, deletedAt: null, status: "READY" }, _sum: { size: true }, _count: true }),
  ]);
  const importBytes = imports._sum.declaredSize ?? 0n;
  const byCategory = new Map<string, { bytes: bigint; count: number }>();
  for (const row of assets) {
    const key = categoryOf(row.mime);
    const current = byCategory.get(key) ?? { bytes: 0n, count: 0 };
    byCategory.set(key, { bytes: current.bytes + (row._sum.size ?? 0n), count: current.count + row._count });
  }
  return {
    limitBytes: organization.storageLimitBytes,
    assetBytes: organization.storageUsedBytes,
    reservedBytes: organization.storageReservedBytes,
    importBytes,
    usedBytes: organization.storageUsedBytes + organization.storageReservedBytes + importBytes,
    assetCount: assets.reduce((sum, row) => sum + row._count, 0),
    importCount: imports._count,
    byCategory: [...byCategory.entries()].map(([category, value]) => ({ category: category as StorageUsage["byCategory"][number]["category"], ...value })).sort((a, b) => Number(b.bytes - a.bytes)),
  };
}

/** Rejects an upload that would take the organization past its storage limit (assets and dataset imports share it). */
export async function assertStorageAvailable(tx: Transaction, organizationId: string, incomingBytes: bigint) {
  const usage = await organizationStorage(tx, organizationId);
  if (usage.usedBytes + incomingBytes > usage.limitBytes) fail(409, "QUOTA_EXCEEDED", "Organization storage quota is exceeded");
}

/** Read model for the Administration panels (bytes cross the JSON boundary as decimal strings). */
export async function storageSummary(userId: string, organizationId: string) {
  const usage = await transaction(async (tx) => {
    await authorize(tx, userId, organizationId, "organization.read");
    return organizationStorage(tx, organizationId);
  });
  return {
    limitBytes: String(usage.limitBytes),
    usedBytes: String(usage.usedBytes),
    assetBytes: String(usage.assetBytes),
    reservedBytes: String(usage.reservedBytes),
    importBytes: String(usage.importBytes),
    assetCount: usage.assetCount,
    importCount: usage.importCount,
    byCategory: usage.byCategory.map((row) => ({ category: row.category, bytes: String(row.bytes), count: row.count })),
  };
}
