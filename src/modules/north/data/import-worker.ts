import { createHash, randomUUID } from "node:crypto";
import type { ObjectStorage } from "../../../infrastructure/object-storage.js";
import type { NorthDatasetImportScanStatus } from "../../../lib/database.js";
import { DomainError } from "../../../shared/errors.js";
import { transaction } from "../../../shared/transaction.js";
import { auditRepository } from "../../audit/repository.js";
import { validateUploadedDatasetImport } from "./import-policy.js";
import { northDatasetImportWorkerRepository as repo } from "./import-worker-repository.js";
import type { DatasetImportMalwareScanner } from "./import-malware-scanner.js";
import type { DatasetImportArchiveValidator } from "./import-archive-validator.js";

type ClaimedJob = NonNullable<Awaited<ReturnType<typeof repo.find>>> & { claimToken: string; claimedBy: string };
type AuditAppender = typeof auditRepository.append;

export type DatasetImportWorkerConfiguration = {
  leaseMilliseconds: number;
  heartbeatMilliseconds: number;
  retryDelayMilliseconds: number;
  maximumBytes: number;
};

export type DatasetImportWorkerDependencies = {
  storage: ObjectStorage;
  scanner: DatasetImportMalwareScanner;
  archiveValidator: DatasetImportArchiveValidator;
  configuration: DatasetImportWorkerConfiguration;
  appendAudit?: AuditAppender;
  now?: () => Date;
};

class LeaseLostError extends Error {}

function leaseIdentity(job: ClaimedJob, now: Date) {
  return {
    id: job.id,
    organizationId: job.organizationId,
    datasetId: job.datasetId,
    workerId: job.claimedBy,
    claimToken: job.claimToken,
    now,
  };
}

export class NorthDatasetImportWorker {
  private readonly appendAudit: AuditAppender;
  private readonly now: () => Date;

  constructor(private readonly workerId: string, private readonly dependencies: DatasetImportWorkerDependencies) {
    this.appendAudit = dependencies.appendAudit ?? auditRepository.append;
    this.now = dependencies.now ?? (() => new Date());
  }

  private async claim() {
    return transaction(async (tx) => {
      const now = this.now();
      const candidates = await repo.candidates(tx, now);
      for (const candidate of candidates) {
        if (candidate.attempts >= candidate.maxAttempts) {
          const exhausted = await repo.failExpiredExhausted(tx, {
            id: candidate.id,
            organizationId: candidate.organizationId,
            datasetId: candidate.datasetId,
            expectedStatus: candidate.status,
            expectedAttempts: candidate.attempts,
            expectedClaimToken: candidate.claimToken,
            expectedClaimExpiresAt: candidate.claimExpiresAt,
            now,
          });
          if (exhausted.count === 1) {
            await this.appendAudit(tx, {
              organizationId: candidate.organizationId,
              action: "NORTH_DATASET_IMPORT_FAILED",
              targetType: "NorthDatasetImportJob",
              targetId: candidate.id,
              metadata: { datasetId: candidate.datasetId, reason: "IMPORT_RETRY_EXHAUSTED", attempts: candidate.attempts },
            });
            return "EXHAUSTED" as const;
          }
          continue;
        }
        const claimToken = randomUUID();
        const result = await repo.claim(tx, {
          id: candidate.id,
          organizationId: candidate.organizationId,
          datasetId: candidate.datasetId,
          expectedStatus: candidate.status,
          expectedAttempts: candidate.attempts,
          expectedClaimToken: candidate.claimToken,
          expectedClaimExpiresAt: candidate.claimExpiresAt,
          workerId: this.workerId,
          claimToken,
          now,
          expiresAt: new Date(now.getTime() + this.dependencies.configuration.leaseMilliseconds),
        });
        if (result.count !== 1) continue;
        const claimed = await repo.find(tx, candidate.id, candidate.organizationId, candidate.datasetId);
        if (claimed?.claimToken === claimToken && claimed.claimedBy === this.workerId)
          return claimed as ClaimedJob;
      }
      return null;
    });
  }

  private async renew(job: ClaimedJob) {
    return transaction(async (tx) => {
      const now = this.now();
      const result = await repo.renew(tx, {
        ...leaseIdentity(job, now),
        expiresAt: new Date(now.getTime() + this.dependencies.configuration.leaseMilliseconds),
      });
      return result.count === 1;
    });
  }

  private async withHeartbeat<T>(job: ClaimedJob, work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    let lost = false;
    let pending = Promise.resolve();
    const renew = () => {
      pending = pending.then(async () => {
        if (lost) return;
        if (!(await this.renew(job))) {
          lost = true;
          controller.abort();
        }
      });
    };
    const timer = setInterval(renew, this.dependencies.configuration.heartbeatMilliseconds);
    try {
      const value = await work(controller.signal);
      renew();
      await pending;
      if (lost) throw new LeaseLostError();
      return value;
    } finally {
      clearInterval(timer);
      await pending;
    }
  }

  private async verifyPrivateObject(job: ClaimedJob, signal: AbortSignal) {
    const versionId = this.immutableVersionId(job);
    const metadata = await this.dependencies.storage.inspect(job.storageKey, versionId);
    if (metadata.versionId !== versionId)
      throw new DomainError(
        503,
        "IMPORT_STORAGE_IMMUTABILITY_UNAVAILABLE",
        "Dataset import storage did not return the pinned object version",
      );
    const stream = await this.dependencies.storage.openPrivateRead(job.storageKey, versionId);
    const digest = createHash("sha256");
    const prefix: number[] = [];
    let size = 0;
    try {
      for await (const value of stream) {
        if (signal.aborted) throw new LeaseLostError();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.byteLength;
        if (size > this.dependencies.configuration.maximumBytes || size > Number(job.declaredSize))
          throw new DomainError(422, "IMPORT_SIZE_MISMATCH", "Uploaded import size does not match its declaration");
        digest.update(chunk);
        for (let index = 0; index < chunk.length && prefix.length < 64; index++) prefix.push(chunk[index]!);
      }
    } finally {
      stream.destroy();
    }
    validateUploadedDatasetImport(job, {
      size,
      mime: metadata.mime,
      checksum: digest.digest("hex"),
      prefix: Uint8Array.from(prefix),
    });
  }

  private immutableVersionId(job: ClaimedJob) {
    if (!job.storageVersionId || job.storageVersionId === "null")
      throw new DomainError(
        503,
        "IMPORT_STORAGE_IMMUTABILITY_UNAVAILABLE",
        "Dataset import does not have a pinned immutable object version",
      );
    return job.storageVersionId;
  }

  private async progress(job: ClaimedJob, progress: number, scanStatus?: NorthDatasetImportScanStatus) {
    const count = await transaction(async (tx) => {
      const result = await repo.progress(tx, { ...leaseIdentity(job, this.now()), progress, scanStatus });
      return result.count;
    });
    if (count !== 1) throw new LeaseLostError();
  }

  private async reject(job: ClaimedJob, errorCode: string, scanStatus: NorthDatasetImportScanStatus) {
    return transaction(async (tx) => {
      const now = this.now();
      const result = await repo.reject(tx, { ...leaseIdentity(job, now), errorCode, scanStatus });
      if (result.count !== 1) return false;
      await this.appendAudit(tx, {
        organizationId: job.organizationId,
        action: "NORTH_DATASET_IMPORT_WORKER_REJECTED",
        targetType: "NorthDatasetImportJob",
        targetId: job.id,
        metadata: { datasetId: job.datasetId, reason: errorCode, scanStatus },
      });
      return true;
    });
  }

  private async block(job: ClaimedJob, errorCode: string, scanStatus?: NorthDatasetImportScanStatus) {
    return transaction(async (tx) => {
      const now = this.now();
      const status = job.attempts >= job.maxAttempts ? "FAILED" as const : "SECURITY_BLOCKED" as const;
      const result = await repo.block(tx, {
        ...leaseIdentity(job, now),
        status,
        scanStatus,
        errorCode,
        retryAt: new Date(now.getTime() + this.dependencies.configuration.retryDelayMilliseconds),
      });
      if (result.count !== 1) return false;
      await this.appendAudit(tx, {
        organizationId: job.organizationId,
        action: status === "FAILED" ? "NORTH_DATASET_IMPORT_FAILED" : "NORTH_DATASET_IMPORT_BLOCKED",
        targetType: "NorthDatasetImportJob",
        targetId: job.id,
        metadata: { datasetId: job.datasetId, reason: errorCode, attempt: job.attempts, maxAttempts: job.maxAttempts },
      });
      return true;
    });
  }

  private async approve(job: ClaimedJob) {
    return transaction(async (tx) => {
      const now = this.now();
      const result = await repo.approve(tx, leaseIdentity(job, now));
      if (result.count !== 1) return false;
      await this.appendAudit(tx, {
        organizationId: job.organizationId,
        action: "NORTH_DATASET_IMPORT_SECURITY_APPROVED",
        targetType: "NorthDatasetImportJob",
        targetId: job.id,
        metadata: { datasetId: job.datasetId },
      });
      return true;
    });
  }

  private async finalizeCancellation(job: ClaimedJob) {
    return transaction(async (tx) => {
      const now = this.now();
      const result = await repo.finalizeCancellation(tx, leaseIdentity(job, now));
      if (result.count !== 1) return false;
      await this.appendAudit(tx, {
        organizationId: job.organizationId,
        action: "NORTH_DATASET_IMPORT_CANCELLED_BY_WORKER",
        targetType: "NorthDatasetImportJob",
        targetId: job.id,
        metadata: { datasetId: job.datasetId },
      });
      return true;
    });
  }

  private async recoverExpiredCancellation() {
    return transaction(async (tx) => {
      const now = this.now();
      const candidate = await repo.recoverExpiredCancellation(tx, now);
      if (!candidate) return false;
      const result = await repo.finalizeExpiredCancellation(tx, {
        id: candidate.id,
        organizationId: candidate.organizationId,
        datasetId: candidate.datasetId,
        expectedClaimToken: candidate.claimToken,
        expectedClaimExpiresAt: candidate.claimExpiresAt,
        now,
      });
      if (result.count !== 1) return false;
      await this.appendAudit(tx, {
        organizationId: candidate.organizationId,
        action: "NORTH_DATASET_IMPORT_EXPIRED_CANCELLATION_RECOVERED",
        targetType: "NorthDatasetImportJob",
        targetId: candidate.id,
        metadata: { datasetId: candidate.datasetId },
      });
      return true;
    });
  }

  async runOnce() {
    if (await this.recoverExpiredCancellation()) return "CANCELLED" as const;
    const job = await this.claim();
    if (!job) return "IDLE" as const;
    if (job === "EXHAUSTED") return "FAILED" as const;
    try {
      await this.withHeartbeat(job, (signal) => this.verifyPrivateObject(job, signal));
      await this.progress(job, 20, "SCANNING");
      const verdict = await this.withHeartbeat(job, (signal) => this.dependencies.scanner.scan({
        filename: job.filename,
        mime: job.declaredMime,
        size: Number(job.declaredSize),
        checksum: job.declaredChecksum,
        openPrivateRead: () => this.dependencies.storage.openPrivateRead(job.storageKey, this.immutableVersionId(job)),
        signal,
      }));
      if (verdict !== "APPROVED") {
        const scanStatus = verdict === "QUARANTINED" ? "QUARANTINED" : "REJECTED";
        if (!(await this.reject(job, verdict === "QUARANTINED" ? "IMPORT_QUARANTINED" : "IMPORT_MALWARE_REJECTED", scanStatus)))
          throw new LeaseLostError();
        return "REJECTED" as const;
      }
      await this.progress(job, 35, "APPROVED");
      await this.withHeartbeat(job, (signal) => this.dependencies.archiveValidator.validate({
        filename: job.filename,
        size: Number(job.declaredSize),
        checksum: job.declaredChecksum,
        openPrivateRead: () => this.dependencies.storage.openPrivateRead(job.storageKey, this.immutableVersionId(job)),
        signal,
      }));
      if (!(await this.approve(job))) throw new LeaseLostError();
      return "SECURITY_APPROVED" as const;
    } catch (error) {
      if (error instanceof LeaseLostError) {
        if (await this.finalizeCancellation(job)) return "CANCELLED" as const;
        return "LEASE_LOST" as const;
      }
      if (error instanceof DomainError && error.statusCode === 422) {
        if (!(await this.reject(job, error.code, "REJECTED"))) return "LEASE_LOST" as const;
        return "REJECTED" as const;
      }
      const code = error instanceof DomainError ? error.code : "IMPORT_WORKER_ERROR";
      const scanStatus = code === "IMPORT_MALWARE_SCANNER_UNAVAILABLE" ? "UNAVAILABLE" as const : undefined;
      if (!(await this.block(job, code, scanStatus))) {
        if (await this.finalizeCancellation(job)) return "CANCELLED" as const;
        return "LEASE_LOST" as const;
      }
      return job.attempts >= job.maxAttempts ? "FAILED" as const : "BLOCKED" as const;
    }
  }
}
