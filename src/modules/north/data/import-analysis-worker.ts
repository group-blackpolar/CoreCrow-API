import { randomUUID } from "node:crypto";
import { DomainError } from "../../../shared/errors.js";
import { transaction } from "../../../shared/transaction.js";
import { auditRepository } from "../../audit/repository.js";
import { northDatasetImportAnalysisRepository as analysisRepo } from "./import-analysis-repository.js";
import type { DatasetImportAnalyzer } from "./import-analysis-parser.js";

type Claimed = { id: string; organizationId: string; datasetId: string; storageKey: string; storageVersionId: string; claimToken: string; claimedBy: string; attempts: number; maxAttempts: number };
export type DatasetImportAnalysisWorkerConfiguration = { leaseMilliseconds: number; heartbeatMilliseconds: number; retryDelayMilliseconds: number };
class LeaseLostError extends Error {}

export class NorthDatasetImportAnalysisWorker {
  constructor(private readonly workerId: string, private readonly analyzer: DatasetImportAnalyzer, private readonly configuration: DatasetImportAnalysisWorkerConfiguration, private readonly now = () => new Date()) {}

  private where(job: Claimed, now = this.now()) {
    return { id: job.id, organizationId: job.organizationId, datasetId: job.datasetId, status: "ANALYZING" as const, claimedBy: job.claimedBy, claimToken: job.claimToken, claimExpiresAt: { gt: now } };
  }

  private async claim() {
    return transaction(async (tx) => {
      const now = this.now();
      const candidates = await tx.northDatasetImportJob.findMany({
        where: { status: { in: ["SECURITY_APPROVED", "ANALYSIS_BLOCKED", "ANALYZING"] }, cancellationRequestedAt: null, availableAt: { lte: now }, OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }] },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }], take: 20,
      });
      for (const candidate of candidates) {
        if (!candidate.storageVersionId) continue;
        if (candidate.attempts >= candidate.maxAttempts) {
          const exhausted = await tx.northDatasetImportJob.updateMany({
            where: { id: candidate.id, organizationId: candidate.organizationId, datasetId: candidate.datasetId, status: candidate.status, attempts: candidate.attempts, claimToken: candidate.claimToken, claimExpiresAt: candidate.claimExpiresAt, cancellationRequestedAt: null },
            data: { status: "FAILED", progress: 100, completedAt: now, lastErrorCode: "IMPORT_RETRY_EXHAUSTED", claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null },
          });
          if (exhausted.count) {
            await auditRepository.append(tx, { organizationId: candidate.organizationId, action: "NORTH_DATASET_IMPORT_FAILED", targetType: "NorthDatasetImportJob", targetId: candidate.id, metadata: { datasetId: candidate.datasetId, reason: "IMPORT_RETRY_EXHAUSTED", attempts: candidate.attempts } });
            return "EXHAUSTED" as const;
          }
          continue;
        }
        const claimToken = randomUUID();
        const result = await tx.northDatasetImportJob.updateMany({
          where: { id: candidate.id, organizationId: candidate.organizationId, datasetId: candidate.datasetId, status: candidate.status, attempts: candidate.attempts, claimToken: candidate.claimToken, claimExpiresAt: candidate.claimExpiresAt, cancellationRequestedAt: null, availableAt: { lte: now } },
          data: { status: "ANALYZING", attempts: { increment: 1 }, claimedAt: now, claimExpiresAt: new Date(now.getTime() + this.configuration.leaseMilliseconds), claimedBy: this.workerId, claimToken, lastErrorCode: null },
        });
        if (result.count !== 1) continue;
        return { id: candidate.id, organizationId: candidate.organizationId, datasetId: candidate.datasetId, storageKey: candidate.storageKey, storageVersionId: candidate.storageVersionId, claimToken, claimedBy: this.workerId, attempts: candidate.attempts + 1, maxAttempts: candidate.maxAttempts } satisfies Claimed;
      }
      return null;
    });
  }

  private async withHeartbeat<T>(job: Claimed, work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    let lost = false;
    let pending = Promise.resolve();
    const renew = () => {
      pending = pending.then(async () => {
        if (lost) return;
        const now = this.now();
        const result = await transaction((tx) => tx.northDatasetImportJob.updateMany({ where: { ...this.where(job, now), cancellationRequestedAt: null }, data: { claimExpiresAt: new Date(now.getTime() + this.configuration.leaseMilliseconds) } }));
        if (!result.count) { lost = true; controller.abort(new LeaseLostError()); }
      });
    };
    const timer = setInterval(renew, this.configuration.heartbeatMilliseconds);
    try {
      const value = await work(controller.signal);
      renew(); await pending;
      if (lost) throw new LeaseLostError();
      return value;
    } finally { clearInterval(timer); await pending; }
  }

  private async finalizeCancellation(job: Claimed) {
    return transaction(async (tx) => {
      const now = this.now();
      const result = await tx.northDatasetImportJob.updateMany({ where: { ...this.where(job, now), status: "CANCEL_REQUESTED" }, data: { status: "CANCELLED", progress: 100, cancelledAt: now, completedAt: now, claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null } });
      if (!result.count) return false;
      await auditRepository.append(tx, { organizationId: job.organizationId, action: "NORTH_DATASET_IMPORT_CANCELLED_BY_ANALYSIS_WORKER", targetType: "NorthDatasetImportJob", targetId: job.id, metadata: { datasetId: job.datasetId } });
      return true;
    });
  }

  private async recoverExpiredCancellation() {
    return transaction(async (tx) => {
      const now = this.now();
      const candidate = await tx.northDatasetImportJob.findFirst({ where: { status: "CANCEL_REQUESTED", claimExpiresAt: { lte: now } }, orderBy: [{ cancellationRequestedAt: "asc" }, { id: "asc" }] });
      if (!candidate) return false;
      const result = await tx.northDatasetImportJob.updateMany({ where: { id: candidate.id, organizationId: candidate.organizationId, datasetId: candidate.datasetId, status: "CANCEL_REQUESTED", claimToken: candidate.claimToken, claimExpiresAt: candidate.claimExpiresAt }, data: { status: "CANCELLED", progress: 100, cancelledAt: now, completedAt: now, claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null } });
      if (!result.count) return false;
      await auditRepository.append(tx, { organizationId: candidate.organizationId, action: "NORTH_DATASET_IMPORT_EXPIRED_CANCELLATION_RECOVERED", targetType: "NorthDatasetImportJob", targetId: candidate.id, metadata: { datasetId: candidate.datasetId } });
      return true;
    });
  }

  private async finish(job: Claimed, requested: "REJECTED" | "ANALYSIS_BLOCKED", code: string) {
    return transaction(async (tx) => {
      const now = this.now();
      const status = requested === "ANALYSIS_BLOCKED" && job.attempts >= job.maxAttempts ? "FAILED" : requested;
      const result = await tx.northDatasetImportJob.updateMany({
        where: this.where(job, now),
        data: status === "REJECTED"
          ? { status, progress: 100, completedAt: now, lastErrorCode: code, claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null }
          : { status, ...(status === "FAILED" ? { progress: 100, completedAt: now, lastErrorCode: "IMPORT_RETRY_EXHAUSTED" } : { availableAt: new Date(now.getTime() + this.configuration.retryDelayMilliseconds), lastErrorCode: code }), claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null },
      });
      if (!result.count) return false;
      const action = status === "REJECTED" ? "NORTH_DATASET_IMPORT_ANALYSIS_REJECTED" : status === "FAILED" ? "NORTH_DATASET_IMPORT_FAILED" : "NORTH_DATASET_IMPORT_ANALYSIS_BLOCKED";
      await auditRepository.append(tx, { organizationId: job.organizationId, action, targetType: "NorthDatasetImportJob", targetId: job.id, metadata: { datasetId: job.datasetId, reason: status === "FAILED" ? "IMPORT_RETRY_EXHAUSTED" : code, attempt: job.attempts, maxAttempts: job.maxAttempts } });
      return true;
    });
  }

  async runOnce() {
    if (await this.recoverExpiredCancellation()) return "CANCELLED" as const;
    const job = await this.claim();
    if (!job) return "IDLE" as const;
    if (job === "EXHAUSTED") return "FAILED" as const;
    try {
      const analyzed = await this.withHeartbeat(job, (signal) => this.analyzer.analyze({ storageKey: job.storageKey, storageVersionId: job.storageVersionId, signal }));
      const completed = await transaction(async (tx) => {
        const result = await tx.northDatasetImportJob.updateMany({ where: { ...this.where(job), cancellationRequestedAt: null }, data: { status: "AWAITING_MAPPING", progress: 70, claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null } });
        if (!result.count) return false;
        await analysisRepo.createAnalysis(tx, { organizationId: job.organizationId, datasetId: job.datasetId, importId: job.id, parserVersion: analyzed.parserVersion, workbook: analyzed.workbook });
        await auditRepository.append(tx, { organizationId: job.organizationId, action: "NORTH_DATASET_IMPORT_ANALYZED", targetType: "NorthDatasetImportAnalysis", targetId: job.id, metadata: { datasetId: job.datasetId, sheets: analyzed.workbook.sheets.length } });
        return true;
      });
      return completed ? "AWAITING_MAPPING" as const : (await this.finalizeCancellation(job) ? "CANCELLED" as const : "LEASE_LOST" as const);
    } catch (error) {
      if (error instanceof LeaseLostError || (error instanceof Error && error.name === "AbortError")) return await this.finalizeCancellation(job) ? "CANCELLED" as const : "LEASE_LOST" as const;
      const invalid = error instanceof DomainError && error.statusCode === 422;
      const code = error instanceof DomainError ? error.code : "IMPORT_ANALYZER_UNAVAILABLE";
      if (!(await this.finish(job, invalid ? "REJECTED" : "ANALYSIS_BLOCKED", code))) return await this.finalizeCancellation(job) ? "CANCELLED" as const : "LEASE_LOST" as const;
      return invalid ? "REJECTED" as const : job.attempts >= job.maxAttempts ? "FAILED" as const : "ANALYSIS_BLOCKED" as const;
    }
  }
}
