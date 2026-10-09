import { Prisma } from "../../../lib/database.js";
import { fail } from "../../../shared/errors.js";
import { transaction, type Transaction } from "../../../shared/transaction.js";
import { auditRepository } from "../../audit/repository.js";
import { authorizeDataset } from "./authorization.js";
import { northDatasetImportAnalysisRepository as repo } from "./import-analysis-repository.js";
import type { DatasetImportMappingInput, DatasetImportWorkbookAnalysis } from "./import-analysis-types.js";

function analysisView(value: { id: string; importId: string; parserVersion: string; workbook: Prisma.JsonValue; createdAt: Date }) {
  return { id: value.id, importId: value.importId, parserVersion: value.parserVersion, workbook: value.workbook, createdAt: value.createdAt };
}

function mappingView(value: { id: string; importId: string; version: number; sheetOrdinal: number; headerRow: number; definition: Prisma.JsonValue; createdBy: string; createdAt: Date }) {
  return {
    id: value.id, importId: value.importId, version: value.version, sheetOrdinal: value.sheetOrdinal,
    headerRow: value.headerRow, definition: value.definition, createdBy: value.createdBy, createdAt: value.createdAt,
  };
}

function workbook(value: Prisma.JsonValue): DatasetImportWorkbookAnalysis {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("sheets" in value) || !Array.isArray(value.sheets))
    fail(409, "IMPORT_ANALYSIS_INVALID", "Stored import analysis is invalid");
  return value as unknown as DatasetImportWorkbookAnalysis;
}

async function authorizedJob(tx: Transaction, userId: string, organizationId: string, datasetId: string, importId: string) {
  await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
  const job = await repo.job(tx, organizationId, datasetId, importId);
  if (!job) fail(404, "NOT_FOUND", "Dataset import not found");
  return job;
}

function ensureMapping(input: DatasetImportMappingInput, analysis: DatasetImportWorkbookAnalysis) {
  const sheet = analysis.sheets.find((candidate) => candidate.ordinal === input.sheetOrdinal);
  if (!sheet || input.headerRow !== 1) fail(422, "IMPORT_MAPPING_INVALID", "Mapping does not reference an analyzed worksheet header");
  if (input.columns.length !== sheet.columns.length) fail(422, "IMPORT_MAPPING_INVALID", "Every analyzed source column must have an explicit action");
  const source = new Set(input.columns.map((column) => column.sourceOrdinal));
  if (source.size !== input.columns.length || sheet.columns.some((column) => !source.has(column.ordinal)))
    fail(422, "IMPORT_MAPPING_INVALID", "Mapping source columns must be unique and complete");
  const mapped = input.columns.filter((column) => column.action === "MAP");
  const ids = mapped.map((column) => column.fieldId);
  if (new Set(ids).size !== ids.length) fail(422, "IMPORT_MAPPING_INVALID", "A stable dataset field may only be mapped once");
}

export const northDatasetImportAnalysis = {
  read(userId: string, organizationId: string, datasetId: string, importId: string) {
    return transaction(async (tx) => {
      await authorizedJob(tx, userId, organizationId, datasetId, importId);
      const analysis = await repo.analysis(tx, organizationId, datasetId, importId);
      if (!analysis) fail(409, "IMPORT_ANALYSIS_NOT_READY", "Import analysis is not ready");
      return analysisView(analysis);
    });
  },
  listMappings(userId: string, organizationId: string, datasetId: string, importId: string) {
    return transaction(async (tx) => {
      await authorizedJob(tx, userId, organizationId, datasetId, importId);
      return (await repo.mappings(tx, organizationId, datasetId, importId)).map(mappingView);
    });
  },
  readMapping(userId: string, organizationId: string, datasetId: string, importId: string, mappingId: string) {
    return transaction(async (tx) => {
      await authorizedJob(tx, userId, organizationId, datasetId, importId);
      const mapping = await repo.mapping(tx, organizationId, datasetId, importId, mappingId);
      if (!mapping) fail(404, "NOT_FOUND", "Dataset import mapping not found");
      return mappingView(mapping);
    });
  },
  createMapping(userId: string, organizationId: string, datasetId: string, importId: string, input: DatasetImportMappingInput) {
    return transaction(async (tx) => {
      const job = await authorizedJob(tx, userId, organizationId, datasetId, importId);
      if (job.status !== "AWAITING_MAPPING") fail(409, "IMPORT_MAPPING_NOT_AVAILABLE", "Import is not awaiting a mapping");
      const analysis = await repo.analysis(tx, organizationId, datasetId, importId);
      if (!analysis) fail(409, "IMPORT_ANALYSIS_NOT_READY", "Import analysis is not ready");
      const result = workbook(analysis.workbook);
      ensureMapping(input, result);
      const fieldIds = input.columns.filter((column) => column.action === "MAP").map((column) => column.fieldId);
      const fields = await repo.fields(tx, organizationId, datasetId, fieldIds);
      if (fields.length !== fieldIds.length) fail(422, "IMPORT_MAPPING_FIELD_INVALID", "Mapping references an unavailable dataset field");
      const createKeys = input.columns.filter((column) => column.action === "CREATE").map((column) => column.key);
      if (new Set(createKeys).size !== createKeys.length) fail(422, "IMPORT_MAPPING_CREATE_KEY_DUPLICATE", "Created dataset field keys must be unique");
      if ((await repo.fieldsByKeys(tx, organizationId, datasetId, createKeys)).length)
        fail(422, "IMPORT_MAPPING_CREATE_KEY_CONFLICT", "Created dataset field keys conflict with active fields");
      const next = await repo.nextMappingVersion(tx, importId);
      let mapping;
      try {
        mapping = await repo.createMapping(tx, {
          organizationId, datasetId, importId, version: (next._max.version ?? 0) + 1,
          sheetOrdinal: input.sheetOrdinal, headerRow: input.headerRow, definition: { columns: input.columns, duplicates: input.duplicates ?? "KEEP" }, createdBy: userId,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
          fail(409, "IMPORT_MAPPING_VERSION_CONFLICT", "Mapping version changed; retry creation");
        throw error;
      }
      await auditRepository.append(tx, {
        actorId: userId, organizationId, action: "NORTH_DATASET_IMPORT_MAPPING_CREATED",
        targetType: "NorthDatasetImportMappingVersion", targetId: mapping.id,
        metadata: { datasetId, importId, version: mapping.version, columnCount: input.columns.length },
      });
      return mappingView(mapping);
    });
  },
};
