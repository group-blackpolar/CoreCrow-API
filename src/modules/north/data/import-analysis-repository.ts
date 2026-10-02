import { Prisma } from "../../../lib/database.js";
import type { Transaction } from "../../../shared/transaction.js";
import type { DatasetImportWorkbookAnalysis } from "./import-analysis-types.js";

export const northDatasetImportAnalysisRepository = {
  job(tx: Transaction, organizationId: string, datasetId: string, importId: string) {
    return tx.northDatasetImportJob.findFirst({ where: { id: importId, organizationId, datasetId } });
  },
  analysis(tx: Transaction, organizationId: string, datasetId: string, importId: string) {
    return tx.northDatasetImportAnalysis.findFirst({ where: { organizationId, datasetId, importId } });
  },
  mappings(tx: Transaction, organizationId: string, datasetId: string, importId: string) {
    return tx.northDatasetImportMappingVersion.findMany({
      where: { organizationId, datasetId, importId }, orderBy: [{ version: "desc" }],
    });
  },
  mapping(tx: Transaction, organizationId: string, datasetId: string, importId: string, mappingId: string) {
    return tx.northDatasetImportMappingVersion.findFirst({ where: { id: mappingId, organizationId, datasetId, importId } });
  },
  fields(tx: Transaction, organizationId: string, datasetId: string, ids: string[]) {
    return tx.northDatasetField.findMany({ where: { organizationId, datasetId, id: { in: ids }, status: "ACTIVE" } });
  },
  fieldsByKeys(tx: Transaction, organizationId: string, datasetId: string, keys: string[]) {
    return tx.northDatasetField.findMany({ where: { organizationId, datasetId, key: { in: keys } } });
  },
  nextMappingVersion(tx: Transaction, importId: string) {
    return tx.northDatasetImportMappingVersion.aggregate({ where: { importId }, _max: { version: true } });
  },
  createMapping(tx: Transaction, input: {
    organizationId: string; datasetId: string; importId: string; version: number; sheetOrdinal: number; headerRow: number;
    definition: DatasetImportWorkbookAnalysis | { columns: unknown[] }; createdBy: string;
  }) {
    return tx.northDatasetImportMappingVersion.create({ data: { ...input, definition: input.definition as Prisma.InputJsonValue } });
  },
  createAnalysis(tx: Transaction, input: {
    organizationId: string; datasetId: string; importId: string; parserVersion: string; workbook: DatasetImportWorkbookAnalysis;
  }) {
    return tx.northDatasetImportAnalysis.create({ data: { ...input, workbook: input.workbook as Prisma.InputJsonValue } });
  },
};
