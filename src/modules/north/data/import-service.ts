import { assertStorageAvailable } from "../storage-usage.js";
import { randomUUID } from "node:crypto";
import { Prisma, type NorthDatasetImportStatus } from "../../../lib/database.js";
import type { ObjectStorage } from "../../../infrastructure/object-storage.js";
import { DomainError, fail } from "../../../shared/errors.js";
import { transaction, type Transaction } from "../../../shared/transaction.js";
import { hash } from "../../security/crypto.js";
import { auditRepository } from "../../audit/repository.js";
import { authorizeDataset } from "./authorization.js";
import { datasetImportConfiguration, type DatasetImportConfiguration } from "./import-config.js";
import { validateDatasetImportDeclaration, validateUploadedDatasetImport, type DatasetImportDeclaration } from "./import-policy.js";
import { northDatasetImportRepository as repo } from "./import-repository.js";
import { datasetImportStorageFromEnvironment } from "./import-storage.js";

const IDEMPOTENCY_OPERATION = "DATASET_IMPORT_PREPARE";
/** Part size of resumable uploads (S3 minimum is 5 MiB except for the last part). */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
type ImportJob = NonNullable<Awaited<ReturnType<typeof repo.find>>>;
type AuditAppender = typeof auditRepository.append;

export function importView(job: ImportJob) {
  return {
    id: job.id,
    organizationId: job.organizationId,
    datasetId: job.datasetId,
    requestedBy: job.requestedBy,
    filename: job.filename,
    mime: job.declaredMime,
    size: Number(job.declaredSize),
    checksum: job.declaredChecksum,
    status: job.status,
    scanStatus: job.scanStatus,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    confirmedAt: job.confirmedAt,
    securityApprovedAt: job.securityApprovedAt,
    cancellationRequestedAt: job.cancellationRequestedAt,
    cancelledAt: job.cancelledAt,
    completedAt: job.completedAt,
    errorCode: job.lastErrorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function canonicalRequestHash(datasetId: string, input: ReturnType<typeof validateDatasetImportDeclaration>) {
  return hash(JSON.stringify({
    operation: IDEMPOTENCY_OPERATION,
    datasetId,
    filename: input.filename,
    mime: input.mime,
    size: input.size,
    checksum: input.checksum,
  }));
}

function ensureReplayMatches(job: ImportJob, requestHash: string) {
  if (job.requestHash !== requestHash)
    fail(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different import request");
  return job;
}

const immediateCancellation = new Set<NorthDatasetImportStatus>([
  "AWAITING_UPLOAD",
  "SECURITY_PENDING",
  "SECURITY_BLOCKED",
  "SECURITY_APPROVED",
  "ANALYSIS_BLOCKED",
  "AWAITING_MAPPING",
  "READY_TO_ACTIVATE",
]);
const terminal = new Set<NorthDatasetImportStatus>(["SUCCEEDED", "CANCELLED", "REJECTED", "FAILED"]);

export type DatasetImportDependencies = {
  storage: ObjectStorage;
  configuration: DatasetImportConfiguration;
  appendAudit?: AuditAppender;
};

export class NorthDatasetImportService {
  private readonly appendAudit: AuditAppender;

  constructor(private readonly dependencies: DatasetImportDependencies) {
    this.appendAudit = dependencies.appendAudit ?? auditRepository.append;
  }

  private async authorizedJob(
    tx: Transaction,
    userId: string,
    organizationId: string,
    datasetId: string,
    importId: string,
  ) {
    await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
    const job = await repo.find(tx, organizationId, datasetId, importId);
    if (!job) fail(404, "NOT_FOUND", "Dataset import not found");
    return job;
  }

  async prepare(
    userId: string,
    organizationId: string,
    datasetId: string,
    input: DatasetImportDeclaration,
    idempotencyKey: string,
  ) {
    const declared = validateDatasetImportDeclaration(input, this.dependencies.configuration);
    const requestHash = canonicalRequestHash(datasetId, declared);
    const persist = () => transaction(async (tx) => {
      const { dataset, membership } = await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      if (dataset.status !== "ACTIVE") fail(409, "DATASET_ARCHIVED", "Archived datasets cannot accept imports");
      const replay = await repo.replay(tx, organizationId, membership.id, userId, idempotencyKey);
      if (replay) return ensureReplayMatches(replay, requestHash);
      await assertStorageAvailable(tx, organizationId, BigInt(declared.size));
      const id = randomUUID();
      const job = await repo.create(tx, {
        id,
        organizationId,
        datasetId,
        requestedBy: userId,
        requestedMembershipId: membership.id,
        idempotencyKey,
        requestHash,
        filename: declared.filename,
        declaredMime: declared.mime,
        declaredSize: BigInt(declared.size),
        declaredChecksum: declared.checksum,
        storageKey: `north-data-imports/${randomUUID()}`,
      });
      await this.appendAudit(tx, {
        actorId: userId,
        organizationId,
        action: "NORTH_DATASET_IMPORT_CREATED",
        targetType: "NorthDatasetImportJob",
        targetId: job.id,
        metadata: { datasetId, mime: declared.mime, size: declared.size, status: job.status },
      });
      return job;
    });

    let job: ImportJob;
    try {
      job = await persist();
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      job = await transaction(async (tx) => {
        const { membership } = await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
        const replay = await repo.replay(tx, organizationId, membership.id, userId, idempotencyKey);
        if (!replay) throw error;
        return ensureReplayMatches(replay, requestHash);
      });
    }
    if (job.status !== "AWAITING_UPLOAD")
      fail(409, "IMPORT_UPLOAD_NOT_AVAILABLE", "This import no longer accepts an upload");
    const upload = await this.dependencies.storage.signedPut({
      key: job.storageKey,
      mime: job.declaredMime,
      size: Number(job.declaredSize),
      checksum: job.declaredChecksum,
      ttlSeconds: this.dependencies.configuration.uploadUrlTtlSeconds,
    });
    return { import: importView(job), upload };
  }

  list(userId: string, organizationId: string, datasetId: string) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      return (await repo.list(tx, organizationId, datasetId)).map(importView);
    });
  }

  read(userId: string, organizationId: string, datasetId: string, importId: string) {
    return transaction(async (tx) => importView(
      await this.authorizedJob(tx, userId, organizationId, datasetId, importId),
    ));
  }

  async confirm(userId: string, organizationId: string, datasetId: string, importId: string) {
    const job = await transaction((tx) => this.authorizedJob(tx, userId, organizationId, datasetId, importId));
    if (job.status !== "AWAITING_UPLOAD") {
      if (job.status === "CANCELLED" || job.status === "CANCEL_REQUESTED")
        fail(409, "IMPORT_CANCELLED", "Cancelled imports cannot be confirmed");
      if (job.status === "REJECTED" || job.status === "FAILED")
        fail(409, "IMPORT_NOT_PROCESSABLE", "Import is not processable");
      return importView(job);
    }

    let storageVersionId: string;
    let storageEtag: string | undefined;
    try {
      const inspected = await this.dependencies.storage.inspect(job.storageKey);
      if (!inspected.versionId || inspected.versionId === "null")
        fail(
          503,
          "IMPORT_STORAGE_IMMUTABILITY_UNAVAILABLE",
          "Dataset import storage did not provide an immutable object version",
        );
      // A multipart object has no whole-file SHA-256 in its metadata; the worker re-hashes the stored bytes and rejects a mismatch.
      validateUploadedDatasetImport(job, job.multipartUploadId ? { ...inspected, checksum: job.declaredChecksum } : inspected);
      storageVersionId = inspected.versionId;
      storageEtag = inspected.etag;
    } catch (error) {
      if (error instanceof DomainError && error.statusCode === 422) {
        await transaction(async (tx) => {
          const current = await this.authorizedJob(tx, userId, organizationId, datasetId, importId);
          if (current.status !== "AWAITING_UPLOAD") return;
          const result = await repo.reject(tx, organizationId, datasetId, importId, error.code, new Date());
          if (result.count !== 1) return;
          const rejected = await repo.find(tx, organizationId, datasetId, importId);
          if (!rejected) fail(404, "NOT_FOUND", "Dataset import not found");
          await this.appendAudit(tx, {
            actorId: userId,
            organizationId,
            action: "NORTH_DATASET_IMPORT_REJECTED",
            targetType: "NorthDatasetImportJob",
            targetId: importId,
            metadata: { datasetId, reason: error.code, status: rejected.status },
          });
        });
      }
      throw error;
    }

    return transaction(async (tx) => {
      const current = await this.authorizedJob(tx, userId, organizationId, datasetId, importId);
      if (current.status !== "AWAITING_UPLOAD") {
        if (current.status === "CANCELLED" || current.status === "CANCEL_REQUESTED")
          fail(409, "IMPORT_CANCELLED", "Cancelled imports cannot be confirmed");
        return importView(current);
      }
      const confirmedAt = new Date();
      const result = await repo.confirm(tx, {
        organizationId,
        datasetId,
        importId,
        confirmedAt,
        storageVersionId,
        storageEtag,
      });
      if (result.count !== 1) {
        const latest = await repo.find(tx, organizationId, datasetId, importId);
        if (!latest) fail(404, "NOT_FOUND", "Dataset import not found");
        if (latest.status === "CANCELLED" || latest.status === "CANCEL_REQUESTED")
          fail(409, "IMPORT_CANCELLED", "Cancelled imports cannot be confirmed");
        return importView(latest);
      }
      const confirmed = await repo.find(tx, organizationId, datasetId, importId);
      if (!confirmed) fail(404, "NOT_FOUND", "Dataset import not found");
      await this.appendAudit(tx, {
        actorId: userId,
        organizationId,
        action: "NORTH_DATASET_IMPORT_CONFIRMED",
        targetType: "NorthDatasetImportJob",
        targetId: importId,
        metadata: { datasetId, status: confirmed.status, scanStatus: confirmed.scanStatus },
      });
      return importView(confirmed);
    });
  }

  private layout(job: ImportJob) {
    const size = Number(job.declaredSize);
    const partSize = job.multipartPartSize ?? MULTIPART_PART_BYTES;
    const partCount = Math.ceil(size / partSize);
    return { size, partSize, partCount, expected: (partNumber: number) => (partNumber < partCount ? partSize : size - partSize * (partCount - 1)) };
  }

  /** Starts (or returns) the resumable upload of an import that is still awaiting its bytes. Safe to call again after a reload. */
  async multipartStart(userId: string, organizationId: string, datasetId: string, importId: string) {
    const job = await transaction((tx) => this.authorizedJob(tx, userId, organizationId, datasetId, importId));
    if (job.status !== "AWAITING_UPLOAD") fail(409, "IMPORT_UPLOAD_NOT_AVAILABLE", "This import no longer accepts an upload");
    if (!job.multipartUploadId) {
      const created = await this.dependencies.storage.createMultipart({ key: job.storageKey, mime: job.declaredMime });
      const claimed = await transaction((tx) => tx.northDatasetImportJob.updateMany({ where: { id: importId, organizationId, datasetId, status: "AWAITING_UPLOAD", multipartUploadId: null }, data: { multipartUploadId: created.uploadId, multipartPartSize: MULTIPART_PART_BYTES } }));
      if (claimed.count !== 1) await this.dependencies.storage.abortMultipart({ key: job.storageKey, uploadId: created.uploadId }).catch(() => undefined);
    }
    return this.multipartState(userId, organizationId, datasetId, importId);
  }

  async multipartState(userId: string, organizationId: string, datasetId: string, importId: string) {
    const job = await transaction((tx) => this.authorizedJob(tx, userId, organizationId, datasetId, importId));
    if (!job.multipartUploadId) fail(409, "IMPORT_MULTIPART_NOT_STARTED", "Start the resumable upload first");
    const layout = this.layout(job);
    const uploaded = job.status === "AWAITING_UPLOAD" ? await this.dependencies.storage.listParts({ key: job.storageKey, uploadId: job.multipartUploadId }) : [];
    return { partSize: layout.partSize, partCount: layout.partCount, uploadedParts: uploaded.filter((part) => part.partNumber <= layout.partCount && part.size === layout.expected(part.partNumber)).map((part) => part.partNumber) };
  }

  async multipartSignPart(userId: string, organizationId: string, datasetId: string, importId: string, partNumber: number) {
    const job = await transaction((tx) => this.authorizedJob(tx, userId, organizationId, datasetId, importId));
    if (!job.multipartUploadId || job.status !== "AWAITING_UPLOAD") fail(409, "IMPORT_UPLOAD_NOT_AVAILABLE", "This import no longer accepts an upload");
    const layout = this.layout(job);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > layout.partCount) fail(422, "IMPORT_PART_INVALID", "Part number is outside the upload");
    return this.dependencies.storage.signedPart({ key: job.storageKey, uploadId: job.multipartUploadId, partNumber, size: layout.expected(partNumber), ttlSeconds: this.dependencies.configuration.uploadUrlTtlSeconds });
  }

  /** Assembles the object only if the store holds exactly the expected parts; the client then calls `confirm` as for a single PUT. */
  async multipartComplete(userId: string, organizationId: string, datasetId: string, importId: string) {
    const job = await transaction((tx) => this.authorizedJob(tx, userId, organizationId, datasetId, importId));
    if (!job.multipartUploadId || job.status !== "AWAITING_UPLOAD") fail(409, "IMPORT_UPLOAD_NOT_AVAILABLE", "This import no longer accepts an upload");
    const layout = this.layout(job);
    const parts = (await this.dependencies.storage.listParts({ key: job.storageKey, uploadId: job.multipartUploadId })).sort((a, b) => a.partNumber - b.partNumber);
    const complete = parts.length === layout.partCount && parts.every((part, index) => part.partNumber === index + 1 && part.size === layout.expected(part.partNumber));
    if (!complete) fail(422, "IMPORT_PARTS_INCOMPLETE", "Some parts are missing or have the wrong size; resume the upload");
    await this.dependencies.storage.completeMultipart({ key: job.storageKey, uploadId: job.multipartUploadId, parts: parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })) });
    return importView(job);
  }

  async cancel(userId: string, organizationId: string, datasetId: string, importId: string) {
    const view = await this.cancelCore(userId, organizationId, datasetId, importId);
    if (view.status === "CANCELLED") {
      // Abandoned parts are billed storage: release them (best effort; a completed upload simply has nothing left to abort).
      const job = await transaction((tx) => repo.find(tx, organizationId, datasetId, importId));
      if (job?.multipartUploadId) await this.dependencies.storage.abortMultipart({ key: job.storageKey, uploadId: job.multipartUploadId }).catch(() => undefined);
    }
    return view;
  }

  private cancelCore(userId: string, organizationId: string, datasetId: string, importId: string) {
    return transaction(async (tx) => {
      const current = await this.authorizedJob(tx, userId, organizationId, datasetId, importId);
      if (current.status === "CANCELLED" || current.status === "CANCEL_REQUESTED") return importView(current);
      if (terminal.has(current.status)) fail(409, "IMPORT_NOT_CANCELLABLE", "Completed imports cannot be cancelled");
      const now = new Date();
      const hasActiveLease = Boolean(current.claimedBy && current.claimExpiresAt && current.claimExpiresAt > now);
      const status: NorthDatasetImportStatus = !hasActiveLease && immediateCancellation.has(current.status)
        ? "CANCELLED"
        : "CANCEL_REQUESTED";
      const result = await repo.cancel(tx, {
        organizationId,
        datasetId,
        importId,
        expectedStatus: current.status,
        expectedClaimedBy: current.claimedBy,
        expectedClaimExpiresAt: current.claimExpiresAt,
        expectedClaimToken: current.claimToken,
        status,
        at: now,
      });
      if (result.count !== 1) {
        const latest = await repo.find(tx, organizationId, datasetId, importId);
        if (!latest) fail(404, "NOT_FOUND", "Dataset import not found");
        if (latest.status === "CANCELLED" || latest.status === "CANCEL_REQUESTED") return importView(latest);
        if (terminal.has(latest.status)) fail(409, "IMPORT_NOT_CANCELLABLE", "Completed imports cannot be cancelled");
        fail(409, "IMPORT_STATE_CHANGED", "Import state changed; retry cancellation");
      }
      const cancelled = await repo.find(tx, organizationId, datasetId, importId);
      if (!cancelled) fail(404, "NOT_FOUND", "Dataset import not found");
      await this.appendAudit(tx, {
        actorId: userId,
        organizationId,
        action: status === "CANCELLED" ? "NORTH_DATASET_IMPORT_CANCELLED" : "NORTH_DATASET_IMPORT_CANCELLATION_REQUESTED",
        targetType: "NorthDatasetImportJob",
        targetId: importId,
        metadata: { datasetId, previousStatus: current.status, status },
      });
      return importView(cancelled);
    });
  }
}

let configured = new NorthDatasetImportService({
  storage: datasetImportStorageFromEnvironment(),
  configuration: datasetImportConfiguration(),
});

export function configureNorthDatasetImportService(service: NorthDatasetImportService) {
  configured = service;
}

export const northDatasetImports = {
  prepare: (...args: Parameters<NorthDatasetImportService["prepare"]>) => configured.prepare(...args),
  list: (...args: Parameters<NorthDatasetImportService["list"]>) => configured.list(...args),
  read: (...args: Parameters<NorthDatasetImportService["read"]>) => configured.read(...args),
  confirm: (...args: Parameters<NorthDatasetImportService["confirm"]>) => configured.confirm(...args),
  cancel: (...args: Parameters<NorthDatasetImportService["cancel"]>) => configured.cancel(...args),
  multipartStart: (...args: Parameters<NorthDatasetImportService["multipartStart"]>) => configured.multipartStart(...args),
  multipartState: (...args: Parameters<NorthDatasetImportService["multipartState"]>) => configured.multipartState(...args),
  multipartSignPart: (...args: Parameters<NorthDatasetImportService["multipartSignPart"]>) => configured.multipartSignPart(...args),
  multipartComplete: (...args: Parameters<NorthDatasetImportService["multipartComplete"]>) => configured.multipartComplete(...args),
};
