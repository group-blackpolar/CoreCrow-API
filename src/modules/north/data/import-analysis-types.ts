import type { NorthDatasetFieldType } from "../../../lib/database.js";

export type InferredColumnType = NorthDatasetFieldType | "EMPTY" | "MIXED";

export type DatasetImportColumnAnalysis = {
  ordinal: number;
  header: string | null;
  inferredType: InferredColumnType;
  nonEmptyCount: number;
  nullable: boolean;
};

export type DatasetImportSheetAnalysis = {
  ordinal: number;
  name: string;
  rowCount: number;
  columnCount: number;
  columns: DatasetImportColumnAnalysis[];
};

export type DatasetImportWorkbookAnalysis = { sheets: DatasetImportSheetAnalysis[] };

export type DatasetImportMappingColumn =
  | { sourceOrdinal: number; action: "MAP"; fieldId: string }
  | { sourceOrdinal: number; action: "CREATE"; key: string; displayName: Record<string, string>; canonicalType: NorthDatasetFieldType; nullable?: boolean }
  | { sourceOrdinal: number; action: "IGNORE" };

export type DatasetImportMappingInput = {
  sheetOrdinal: number;
  headerRow: number;
  columns: DatasetImportMappingColumn[];
};
