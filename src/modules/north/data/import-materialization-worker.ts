import { randomUUID } from "node:crypto";
import { Prisma } from "../../../lib/database.js";
import { DomainError } from "../../../shared/errors.js";
import { transaction } from "../../../shared/transaction.js";
import { auditRepository } from "../../audit/repository.js";
import type { DatasetImportMappingColumn } from "./import-analysis-types.js";
import type { DatasetImportMaterializer, MaterializationColumn } from "./import-materialization-parser.js";
import { datasetImportLimits } from "./import-limits.js";

type Claimed = {
  id: string; organizationId: string; datasetId: string; storageKey: string; storageVersionId: string;
  claimToken: string; claimedBy: string; materializationAttempts: number; activationMappingId: string;
  activationRequestedBy: string;
};
type Configuration = { leaseMilliseconds: number; heartbeatMilliseconds: number; retryDelayMilliseconds: number; maxAttempts?: number; transactionTimeoutMilliseconds?: number };
class LeaseLostError extends Error {}

function mappingColumns(value: Prisma.JsonValue): DatasetImportMappingColumn[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("columns" in value) || !Array.isArray(value.columns))
    throw new DomainError(422, "IMPORT_MAPPING_INVALID", "Stored mapping is invalid");
  return value.columns as unknown as DatasetImportMappingColumn[];
}

export class NorthDatasetImportMaterializationWorker {
  constructor(private readonly workerId: string, private readonly materializer: DatasetImportMaterializer, private readonly configuration: Configuration, private readonly now = () => new Date()) {}

  private where(job: Claimed, now = this.now()) {
    return { id: job.id, organizationId: job.organizationId, datasetId: job.datasetId, status: "ACTIVATING" as const, claimedBy: job.claimedBy, claimToken: job.claimToken, claimExpiresAt: { gt: now } };
  }

  private async claim() {
    return transaction(async (tx) => {
      const now = this.now();
      const candidates = await tx.northDatasetImportJob.findMany({
        where: { status: { in: ["READY_TO_ACTIVATE", "ACTIVATING"] }, cancellationRequestedAt: null, activationMappingId: { not: null }, activationRequestedBy: { not: null }, storageVersionId: { not: null }, availableAt: { lte: now }, OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }] },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }], take: 20,
      });
      for (const candidate of candidates) {
        if (!candidate.storageVersionId || !candidate.activationMappingId || !candidate.activationRequestedBy) continue;
        if (candidate.materializationAttempts >= (this.configuration.maxAttempts ?? 3)) {
          const exhausted = await tx.northDatasetImportJob.updateMany({ where: { id: candidate.id, status: candidate.status, claimToken: candidate.claimToken, claimExpiresAt: candidate.claimExpiresAt }, data: { status: "FAILED", progress: 100, completedAt: now, lastErrorCode: "IMPORT_MATERIALIZATION_RETRY_EXHAUSTED", claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null } });
          if (exhausted.count) {
            await auditRepository.append(tx, { actorId: candidate.activationRequestedBy ?? undefined, organizationId: candidate.organizationId, action: "NORTH_DATASET_IMPORT_FAILED", targetType: "NorthDatasetImportJob", targetId: candidate.id, metadata: { datasetId: candidate.datasetId, reason: "IMPORT_MATERIALIZATION_RETRY_EXHAUSTED", attempts: candidate.materializationAttempts } });
            return "EXHAUSTED" as const;
          }
          continue;
        }
        const claimToken = randomUUID();
        const claimed = await tx.northDatasetImportJob.updateMany({
          where: { id: candidate.id, organizationId: candidate.organizationId, datasetId: candidate.datasetId, status: candidate.status, materializationAttempts: candidate.materializationAttempts, claimToken: candidate.claimToken, claimExpiresAt: candidate.claimExpiresAt, cancellationRequestedAt: null },
          data: { status: "ACTIVATING", materializationAttempts: { increment: 1 }, claimedAt: now, claimExpiresAt: new Date(now.getTime() + this.configuration.leaseMilliseconds), claimedBy: this.workerId, claimToken, lastErrorCode: null },
        });
        if (claimed.count === 1) return { id: candidate.id, organizationId: candidate.organizationId, datasetId: candidate.datasetId, storageKey: candidate.storageKey, storageVersionId: candidate.storageVersionId, claimToken, claimedBy: this.workerId, materializationAttempts: candidate.materializationAttempts + 1, activationMappingId: candidate.activationMappingId, activationRequestedBy: candidate.activationRequestedBy } satisfies Claimed;
      }
      return null;
    });
  }

  private async withHeartbeat<T>(job: Claimed, work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    let lost = false;
    let pending = Promise.resolve();
    const renew = () => { pending = pending.then(async () => {
      if (lost) return;
      const now = this.now();
      const result = await transaction((tx) => tx.northDatasetImportJob.updateMany({ where: { ...this.where(job, now), cancellationRequestedAt: null }, data: { claimExpiresAt: new Date(now.getTime() + this.configuration.leaseMilliseconds) } }));
      if (!result.count) { lost = true; controller.abort(new LeaseLostError()); }
    }); };
    const timer = setInterval(renew, this.configuration.heartbeatMilliseconds);
    // The work commits its own lease-fenced completion, so a trailing renewal would fail against the finished job.
    try { const result = await work(controller.signal); if (lost) throw new LeaseLostError(); return result; }
    finally { clearInterval(timer); await pending; }
  }

  private async plan(job: Claimed) {
    return transaction(async (tx) => {
      const mapping = await tx.northDatasetImportMappingVersion.findFirst({ where: { id: job.activationMappingId, importId: job.id, datasetId: job.datasetId, organizationId: job.organizationId } });
      if (!mapping) throw new DomainError(422, "IMPORT_MAPPING_INVALID", "Selected mapping is unavailable");
      const definitions = mappingColumns(mapping.definition);
      const mappedIds = definitions.filter((column): column is Extract<DatasetImportMappingColumn, { action: "MAP" }> => column.action === "MAP").map((column) => column.fieldId);
      const activeFields = await tx.northDatasetField.findMany({ where: { organizationId: job.organizationId, datasetId: job.datasetId, status: "ACTIVE" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const byId = new Map(activeFields.map((field) => [field.id, field]));
      if (mappedIds.some((id) => !byId.has(id))) throw new DomainError(422, "IMPORT_MAPPING_FIELD_INVALID", "Mapped field is unavailable");
      const mappedSet = new Set(mappedIds);
      if (activeFields.some((field) => !mappedSet.has(field.id) && !field.nullable))
        throw new DomainError(422, "IMPORT_REQUIRED_FIELD_MISSING", "Import mapping omits an active non-nullable field");
      const created = definitions.filter((column): column is Extract<DatasetImportMappingColumn, { action: "CREATE" }> => column.action === "CREATE").map((column) => ({ ...column, fieldId: randomUUID() }));
      const createByOrdinal = new Map(created.map((column) => [column.sourceOrdinal, column]));
      const columns: MaterializationColumn[] = definitions.filter((column) => column.action !== "IGNORE").map((column) => {
        if (column.action === "CREATE") { const value = createByOrdinal.get(column.sourceOrdinal)!; return { sourceOrdinal: column.sourceOrdinal, action: "CREATE", fieldId: value.fieldId, canonicalType: column.canonicalType, nullable: column.nullable ?? true }; }
        const field = byId.get(column.fieldId)!;
        return { sourceOrdinal: column.sourceOrdinal, action: "MAP", fieldId: field.id, canonicalType: field.canonicalType, nullable: field.nullable };
      });
      return { mapping, definitions, activeFields, created, columns };
    });
  }

  /**
   * One transaction owns the whole activation: schema, batch, streamed rows, revision and the active pointer commit
   * together or not at all, so a failed or cancelled import never leaves a partial dataset visible. Rows are inserted as
   * the parser child emits them (bounded batches, real backpressure); nothing accumulates in memory.
   */
  private async activate(job: Claimed, plan: Awaited<ReturnType<NorthDatasetImportMaterializationWorker["plan"]>>, signal: AbortSignal) {
    return transaction(async (tx) => {
      const current = await tx.northDatasetImportJob.findFirst({ where: this.where(job) });
      if (!current || current.cancellationRequestedAt) return false;
      if (await tx.northDatasetImportBatch.findUnique({ where: { importId: job.id } })) throw new DomainError(409, "IMPORT_ALREADY_MATERIALIZED", "Import already has an immutable batch");
      for (const field of plan.created) await tx.northDatasetField.create({ data: { id: field.fieldId, organizationId: job.organizationId, datasetId: job.datasetId, key: field.key, displayName: field.displayName, canonicalType: field.canonicalType, nullable: field.nullable ?? true } });
      const activeFields = [...plan.activeFields, ...plan.created.map((field) => ({ id: field.fieldId, canonicalType: field.canonicalType, semanticType: null, nullable: field.nullable ?? true, status: "ACTIVE" as const }))];
      const nextSchema = (await tx.northDatasetSchemaVersion.aggregate({ where: { organizationId: job.organizationId, datasetId: job.datasetId }, _max: { version: true } }))._max.version ?? 0;
      const schema = await tx.northDatasetSchemaVersion.create({ data: { organizationId: job.organizationId, datasetId: job.datasetId, version: nextSchema + 1, createdBy: job.activationRequestedBy } });
      await tx.northDatasetSchemaVersionField.createMany({ data: activeFields.map((field, ordinal) => ({ organizationId: job.organizationId, datasetId: job.datasetId, schemaVersionId: schema.id, datasetFieldId: field.id, canonicalType: field.canonicalType, semanticType: field.semanticType ?? null, nullable: field.nullable, status: field.status ?? "ACTIVE", ordinal })) });
      const batchId = randomUUID();
      let ordinal = 0;
      let rowCount = 0;
      const parsed = await this.materializer.materialize(
        { storageKey: job.storageKey, storageVersionId: job.storageVersionId, sheetOrdinal: plan.mapping.sheetOrdinal, headerRow: plan.mapping.headerRow, columns: plan.columns, signal },
        {
          // Batches are append-only, so the exact count from the validating pass is known before the first insert.
          async begin(summary) {
            rowCount = summary.rowCount;
            await tx.northDatasetImportBatch.create({ data: { id: batchId, organizationId: job.organizationId, datasetId: job.datasetId, importId: job.id, schemaVersionId: schema.id, mappingVersionId: plan.mapping.id, sheetOrdinal: plan.mapping.sheetOrdinal, rowCount: summary.rowCount, parserVersion: summary.parserVersion } });
          },
          async rows(batch) {
            const start = ordinal;
            await tx.northDatasetRow.createMany({ data: batch.map((values, index) => ({ id: randomUUID(), organizationId: job.organizationId, datasetId: job.datasetId, batchId, ordinal: start + index, values: values as Prisma.InputJsonValue })) });
            ordinal += batch.length;
          },
        },
      );
      if (parsed.rowCount !== ordinal || rowCount !== ordinal) throw new DomainError(503, "IMPORT_MATERIALIZER_UNAVAILABLE", "Workbook materializer is unavailable");
      const nextRevision = (await tx.northDatasetRevision.aggregate({ where: { organizationId: job.organizationId, datasetId: job.datasetId }, _max: { version: true } }))._max.version ?? 0;
      const revisionId = randomUUID();
      await tx.northDatasetRevision.create({ data: { id: revisionId, organizationId: job.organizationId, datasetId: job.datasetId, schemaVersionId: schema.id, version: nextRevision + 1, mode: "REPLACE_DATASET", rowCount: ordinal, createdBy: job.activationRequestedBy } });
      await tx.northDatasetRevisionBatch.create({ data: { organizationId: job.organizationId, datasetId: job.datasetId, revisionId, batchId, ordinal: 0 } });
      const published = await tx.northDataset.updateMany({ where: { id: job.datasetId, organizationId: job.organizationId }, data: { currentSchemaVersionId: schema.id, activeRevisionId: revisionId } });
      if (published.count !== 1) throw new LeaseLostError();
      const completedAt = this.now();
      const completed = await tx.northDatasetImportJob.updateMany({ where: this.where(job, completedAt), data: { status: "SUCCEEDED", progress: 100, completedAt, claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null } });
      if (completed.count !== 1) throw new LeaseLostError();
      await auditRepository.append(tx, { actorId: job.activationRequestedBy, organizationId: job.organizationId, action: "NORTH_DATASET_REVISION_ACTIVATED", targetType: "NorthDatasetRevision", targetId: revisionId, metadata: { datasetId: job.datasetId, importId: job.id, batchId, mode: "REPLACE_DATASET", rowCount: ordinal } });
      return true;
    }, { retries: 0, isolationLevel: "ReadCommitted", timeoutMilliseconds: this.configuration.transactionTimeoutMilliseconds ?? datasetImportLimits().materializationTimeoutMilliseconds + 120_000 });
  }

  private async finish(job: Claimed, retryable: boolean, code: string) {
    return transaction(async (tx) => {
      const exhausted = job.materializationAttempts >= (this.configuration.maxAttempts ?? 3);
      const retry = retryable && !exhausted;
      const status = retry ? "READY_TO_ACTIVATE" : "FAILED";
      const result = await tx.northDatasetImportJob.updateMany({ where: this.where(job), data: { status, ...(retry ? { availableAt: new Date(this.now().getTime() + this.configuration.retryDelayMilliseconds), lastErrorCode: code } : { progress: 100, completedAt: this.now(), lastErrorCode: exhausted ? "IMPORT_MATERIALIZATION_RETRY_EXHAUSTED" : code }), claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null } });
      if (result.count) await auditRepository.append(tx, { actorId: job.activationRequestedBy, organizationId: job.organizationId, action: retry ? "NORTH_DATASET_IMPORT_MATERIALIZATION_BLOCKED" : "NORTH_DATASET_IMPORT_FAILED", targetType: "NorthDatasetImportJob", targetId: job.id, metadata: { datasetId: job.datasetId, reason: retry ? code : exhausted ? "IMPORT_MATERIALIZATION_RETRY_EXHAUSTED" : code } });
      return result.count === 1;
    });
  }

  private async finalizeCancellation(job: Claimed) {
    return transaction(async (tx) => {
      const now = this.now();
      const result = await tx.northDatasetImportJob.updateMany({ where: { id: job.id, organizationId: job.organizationId, datasetId: job.datasetId, status: "CANCEL_REQUESTED", claimedBy: job.claimedBy, claimToken: job.claimToken }, data: { status: "CANCELLED", progress: 100, cancelledAt: now, completedAt: now, claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null } });
      return result.count === 1;
    });
  }

  private async recoverExpiredCancellation() {
    return transaction(async (tx) => {
      const now = this.now();
      const candidate = await tx.northDatasetImportJob.findFirst({
        where: { status: "CANCEL_REQUESTED", activationMappingId: { not: null }, claimExpiresAt: { lte: now } },
        orderBy: [{ cancellationRequestedAt: "asc" }, { id: "asc" }],
      });
      if (!candidate) return false;
      const result = await tx.northDatasetImportJob.updateMany({
        where: { id: candidate.id, organizationId: candidate.organizationId, datasetId: candidate.datasetId, status: "CANCEL_REQUESTED", claimToken: candidate.claimToken, claimExpiresAt: candidate.claimExpiresAt },
        data: { status: "CANCELLED", progress: 100, cancelledAt: now, completedAt: now, claimedAt: null, claimExpiresAt: null, claimedBy: null, claimToken: null },
      });
      if (!result.count) return false;
      await auditRepository.append(tx, { organizationId: candidate.organizationId, action: "NORTH_DATASET_IMPORT_EXPIRED_CANCELLATION_RECOVERED", targetType: "NorthDatasetImportJob", targetId: candidate.id, metadata: { datasetId: candidate.datasetId, phase: "MATERIALIZATION" } });
      return true;
    });
  }

  async runOnce() {
    if (await this.recoverExpiredCancellation()) return "CANCELLED" as const;
    const job = await this.claim();
    if (!job) return "IDLE" as const;
    if (job === "EXHAUSTED") return "FAILED" as const;
    try {
      const plan = await this.plan(job);
      const activated = await this.withHeartbeat(job, (signal) => this.activate(job, plan, signal));
      return activated ? "SUCCEEDED" as const : await this.finalizeCancellation(job) ? "CANCELLED" as const : "LEASE_LOST" as const;
    } catch (error) {
      if (error instanceof LeaseLostError || (error instanceof Error && error.name === "AbortError")) return await this.finalizeCancellation(job) ? "CANCELLED" as const : "LEASE_LOST" as const;
      if (process.env.NORTH_IMPORT_DEBUG) console.error("import materialization failed", error);
      const retryable = !(error instanceof DomainError) || error.statusCode >= 500;
      const code = error instanceof DomainError ? error.code : "IMPORT_MATERIALIZER_UNAVAILABLE";
      return await this.finish(job, retryable, code) ? retryable && job.materializationAttempts < (this.configuration.maxAttempts ?? 3) ? "READY_TO_ACTIVATE" as const : "FAILED" as const : await this.finalizeCancellation(job) ? "CANCELLED" as const : "LEASE_LOST" as const;
    }
  }
}
