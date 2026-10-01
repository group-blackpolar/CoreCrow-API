import type { NorthDatasetImportStatus } from "../../../lib/database.js";
import type { Transaction } from "../../../shared/transaction.js";

export const northDatasetImportRepository = {
  replay(
    tx: Transaction,
    organizationId: string,
    requestedMembershipId: string,
    requestedBy: string,
    idempotencyKey: string,
  ) {
    return tx.northDatasetImportJob.findUnique({
      where: {
        organizationId_requestedMembershipId_requestedBy_idempotencyOperation_idempotencyKey: {
          organizationId,
          requestedMembershipId,
          requestedBy,
          idempotencyOperation: "DATASET_IMPORT_PREPARE",
          idempotencyKey,
        },
      },
    });
  },
  create(tx: Transaction, input: {
    id: string;
    organizationId: string;
    datasetId: string;
    requestedBy: string;
    requestedMembershipId: string;
    idempotencyKey: string;
    requestHash: string;
    filename: string;
    declaredMime: string;
    declaredSize: bigint;
    declaredChecksum: string;
    storageKey: string;
  }) {
    return tx.northDatasetImportJob.create({
      data: { ...input, idempotencyOperation: "DATASET_IMPORT_PREPARE" },
    });
  },
  list(tx: Transaction, organizationId: string, datasetId: string) {
    return tx.northDatasetImportJob.findMany({
      where: { organizationId, datasetId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
  },
  find(tx: Transaction, organizationId: string, datasetId: string, importId: string) {
    return tx.northDatasetImportJob.findFirst({ where: { id: importId, organizationId, datasetId } });
  },
  confirm(tx: Transaction, organizationId: string, datasetId: string, importId: string, confirmedAt: Date) {
    return tx.northDatasetImportJob.updateMany({
      where: { id: importId, organizationId, datasetId, status: "AWAITING_UPLOAD" },
      data: { status: "SECURITY_PENDING", progress: 10, confirmedAt, availableAt: confirmedAt },
    });
  },
  reject(tx: Transaction, organizationId: string, datasetId: string, importId: string, errorCode: string, completedAt: Date) {
    return tx.northDatasetImportJob.updateMany({
      where: { id: importId, organizationId, datasetId, status: "AWAITING_UPLOAD" },
      data: { status: "REJECTED", progress: 100, lastErrorCode: errorCode, completedAt },
    });
  },
  cancel(tx: Transaction, input: {
    organizationId: string;
    datasetId: string;
    importId: string;
    expectedStatus: NorthDatasetImportStatus;
    expectedClaimedBy: string | null;
    expectedClaimExpiresAt: Date | null;
    expectedClaimToken: string | null;
    status: NorthDatasetImportStatus;
    at: Date;
  }) {
    return tx.northDatasetImportJob.updateMany({
      where: {
        id: input.importId,
        organizationId: input.organizationId,
        datasetId: input.datasetId,
        status: input.expectedStatus,
        claimedBy: input.expectedClaimedBy,
        claimExpiresAt: input.expectedClaimExpiresAt,
        claimToken: input.expectedClaimToken,
      },
      data: {
        status: input.status,
        cancellationRequestedAt: input.at,
        ...(input.status === "CANCELLED" ? {
          cancelledAt: input.at,
          completedAt: input.at,
          progress: 100,
          claimedAt: null,
          claimExpiresAt: null,
          claimedBy: null,
          claimToken: null,
        } : {}),
      },
    });
  },
};
