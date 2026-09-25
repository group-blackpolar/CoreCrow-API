import type { NorthAssetStatus } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";

export const northAssetRepository = {
  organization(tx: Transaction, organizationId: string) {
    return tx.organization.findUnique({ where: { id: organizationId } });
  },
  asset(tx: Transaction, organizationId: string, assetId: string) {
    return tx.northAsset.findFirst({ where: { id: assetId, organizationId } });
  },
  create(tx: Transaction, input: {
    id: string; organizationId: string; ownerId: string; filename: string;
    mime: string; size: bigint; checksum: string; storageKey: string;
  }) {
    return tx.northAsset.create({ data: input });
  },
  reserve(tx: Transaction, organizationId: string, size: bigint) {
    return tx.organization.update({
      where: { id: organizationId },
      data: { storageReservedBytes: { increment: size } },
    });
  },
  releaseReservation(tx: Transaction, organizationId: string, size: bigint) {
    return tx.organization.update({
      where: { id: organizationId },
      data: { storageReservedBytes: { decrement: size } },
    });
  },
  commitReservation(tx: Transaction, organizationId: string, size: bigint) {
    return tx.organization.update({
      where: { id: organizationId },
      data: { storageReservedBytes: { decrement: size }, storageUsedBytes: { increment: size } },
    });
  },
  releaseUsed(tx: Transaction, organizationId: string, size: bigint) {
    return tx.organization.update({
      where: { id: organizationId },
      data: { storageUsedBytes: { decrement: size } },
    });
  },
  status(tx: Transaction, id: string, status: NorthAssetStatus, confirmedAt?: Date) {
    return tx.northAsset.update({ where: { id }, data: { status, ...(confirmedAt ? { confirmedAt } : {}) } });
  },
  softDelete(tx: Transaction, id: string, deletedAt: Date) {
    return tx.northAsset.update({ where: { id }, data: { deletedAt } });
  },
  readyReference(tx: Transaction, organizationId: string, assetId: string) {
    return tx.northAsset.findFirst({
      where: { id: assetId, organizationId, status: "READY", deletedAt: null },
      select: { id: true },
    });
  },
};
