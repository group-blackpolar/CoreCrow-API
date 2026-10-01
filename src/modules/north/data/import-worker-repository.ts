import type { NorthDatasetImportScanStatus, NorthDatasetImportStatus } from "../../../lib/database.js";
import type { Transaction } from "../../../shared/transaction.js";

const leaseWhere = (input: {
  id: string;
  organizationId: string;
  datasetId: string;
  workerId: string;
  claimToken: string;
  now: Date;
}) => ({
  id: input.id,
  organizationId: input.organizationId,
  datasetId: input.datasetId,
  claimedBy: input.workerId,
  claimToken: input.claimToken,
  claimExpiresAt: { gt: input.now },
});

export const northDatasetImportWorkerRepository = {
  candidates(tx: Transaction, now: Date) {
    return tx.northDatasetImportJob.findMany({
      where: {
        status: { in: ["SECURITY_PENDING", "SECURITY_BLOCKED"] },
        cancellationRequestedAt: null,
        availableAt: { lte: now },
        OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 20,
    });
  },
  claim(tx: Transaction, input: {
    id: string;
    organizationId: string;
    datasetId: string;
    expectedStatus: NorthDatasetImportStatus;
    expectedAttempts: number;
    expectedClaimToken: string | null;
    expectedClaimExpiresAt: Date | null;
    workerId: string;
    claimToken: string;
    now: Date;
    expiresAt: Date;
  }) {
    return tx.northDatasetImportJob.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        datasetId: input.datasetId,
        status: input.expectedStatus,
        attempts: input.expectedAttempts,
        claimToken: input.expectedClaimToken,
        claimExpiresAt: input.expectedClaimExpiresAt,
        cancellationRequestedAt: null,
        availableAt: { lte: input.now },
      },
      data: {
        status: "SECURITY_PENDING",
        attempts: { increment: 1 },
        claimedAt: input.now,
        claimExpiresAt: input.expiresAt,
        claimedBy: input.workerId,
        claimToken: input.claimToken,
        lastErrorCode: null,
      },
    });
  },
  failExpiredExhausted(tx: Transaction, input: {
    id: string;
    organizationId: string;
    datasetId: string;
    expectedStatus: NorthDatasetImportStatus;
    expectedAttempts: number;
    expectedClaimToken: string | null;
    expectedClaimExpiresAt: Date | null;
    now: Date;
  }) {
    return tx.northDatasetImportJob.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        datasetId: input.datasetId,
        status: input.expectedStatus,
        attempts: input.expectedAttempts,
        claimToken: input.expectedClaimToken,
        claimExpiresAt: input.expectedClaimExpiresAt,
        cancellationRequestedAt: null,
        OR: [{ claimToken: null }, { claimExpiresAt: { lte: input.now } }],
      },
      data: {
        status: "FAILED",
        progress: 100,
        lastErrorCode: "IMPORT_RETRY_EXHAUSTED",
        completedAt: input.now,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        claimToken: null,
      },
    });
  },
  find(tx: Transaction, id: string, organizationId: string, datasetId: string) {
    return tx.northDatasetImportJob.findFirst({ where: { id, organizationId, datasetId } });
  },
  renew(tx: Transaction, input: Parameters<typeof leaseWhere>[0] & { expiresAt: Date }) {
    return tx.northDatasetImportJob.updateMany({
      where: {
        ...leaseWhere(input),
        status: "SECURITY_PENDING",
        cancellationRequestedAt: null,
      },
      data: { claimExpiresAt: input.expiresAt },
    });
  },
  progress(tx: Transaction, input: Parameters<typeof leaseWhere>[0] & {
    progress: number;
    scanStatus?: NorthDatasetImportScanStatus;
  }) {
    return tx.northDatasetImportJob.updateMany({
      where: { ...leaseWhere(input), status: "SECURITY_PENDING", cancellationRequestedAt: null },
      data: { progress: input.progress, ...(input.scanStatus ? { scanStatus: input.scanStatus } : {}) },
    });
  },
  reject(tx: Transaction, input: Parameters<typeof leaseWhere>[0] & {
    scanStatus: NorthDatasetImportScanStatus;
    errorCode: string;
  }) {
    return tx.northDatasetImportJob.updateMany({
      where: { ...leaseWhere(input), status: "SECURITY_PENDING" },
      data: {
        status: "REJECTED",
        scanStatus: input.scanStatus,
        progress: 100,
        lastErrorCode: input.errorCode,
        completedAt: input.now,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        claimToken: null,
      },
    });
  },
  block(tx: Transaction, input: Parameters<typeof leaseWhere>[0] & {
    status: "SECURITY_BLOCKED" | "FAILED";
    scanStatus?: NorthDatasetImportScanStatus;
    errorCode: string;
    retryAt: Date;
  }) {
    return tx.northDatasetImportJob.updateMany({
      where: { ...leaseWhere(input), status: "SECURITY_PENDING" },
      data: {
        status: input.status,
        ...(input.scanStatus ? { scanStatus: input.scanStatus } : {}),
        lastErrorCode: input.errorCode,
        availableAt: input.retryAt,
        ...(input.status === "FAILED" ? { completedAt: input.now, progress: 100 } : {}),
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        claimToken: null,
      },
    });
  },
  approve(tx: Transaction, input: Parameters<typeof leaseWhere>[0]) {
    return tx.northDatasetImportJob.updateMany({
      where: {
        ...leaseWhere(input),
        status: "SECURITY_PENDING",
        scanStatus: "APPROVED",
        cancellationRequestedAt: null,
      },
      data: {
        status: "SECURITY_APPROVED",
        progress: 50,
        securityApprovedAt: input.now,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        claimToken: null,
      },
    });
  },
  finalizeCancellation(tx: Transaction, input: Parameters<typeof leaseWhere>[0]) {
    return tx.northDatasetImportJob.updateMany({
      where: { ...leaseWhere(input), status: "CANCEL_REQUESTED" },
      data: {
        status: "CANCELLED",
        progress: 100,
        cancelledAt: input.now,
        completedAt: input.now,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        claimToken: null,
      },
    });
  },
  recoverExpiredCancellation(tx: Transaction, now: Date) {
    return tx.northDatasetImportJob.findFirst({
      where: { status: "CANCEL_REQUESTED", claimExpiresAt: { lte: now } },
      orderBy: [{ cancellationRequestedAt: "asc" }, { id: "asc" }],
    });
  },
  finalizeExpiredCancellation(tx: Transaction, input: {
    id: string;
    organizationId: string;
    datasetId: string;
    expectedClaimToken: string | null;
    expectedClaimExpiresAt: Date | null;
    now: Date;
  }) {
    return tx.northDatasetImportJob.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        datasetId: input.datasetId,
        status: "CANCEL_REQUESTED",
        claimToken: input.expectedClaimToken,
        claimExpiresAt: input.expectedClaimExpiresAt,
      },
      data: {
        status: "CANCELLED",
        progress: 100,
        cancelledAt: input.now,
        completedAt: input.now,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        claimToken: null,
      },
    });
  },
};
