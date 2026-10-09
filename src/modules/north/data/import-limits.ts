const MIB = 1024 * 1024;

export type DatasetImportLimits = {
  /** Compressed XLSX size. */
  maximumCompressedBytes: number;
  maximumEntries: number;
  /** Uncompressed size of any single archive entry. */
  maximumEntryBytes: number;
  /** Uncompressed size of the whole archive. */
  maximumUncompressedBytes: number;
  maximumCompressionRatio: number;
  maximumRows: number;
  maximumColumns: number;
  /** Non-empty cells visited across all sheets. */
  maximumCells: number;
  maximumSheets: number;
  maximumCellTextBytes: number;
  /** Shared strings kept on the heap before spilling to an indexed temp file. */
  sharedStringsMemoryBytes: number;
  maximumSharedStrings: number;
  /** Total bytes the child may emit while materializing. */
  maximumOutputBytes: number;
  analysisTimeoutMilliseconds: number;
  materializationTimeoutMilliseconds: number;
  parserMaxOldSpaceMiB: number;
};

type Bound = { default: number; ceiling: number };

/** Defaults are what a deployment gets with no configuration; ceilings can never be raised by the environment. */
const bounds: Record<keyof DatasetImportLimits, Bound> = {
  maximumCompressedBytes: { default: 50 * MIB, ceiling: 200 * MIB },
  maximumEntries: { default: 2_048, ceiling: 8_192 },
  maximumEntryBytes: { default: 512 * MIB, ceiling: 2_048 * MIB },
  maximumUncompressedBytes: { default: 768 * MIB, ceiling: 4_096 * MIB },
  maximumCompressionRatio: { default: 100, ceiling: 200 },
  maximumRows: { default: 500_000, ceiling: 1_048_576 },
  maximumColumns: { default: 150, ceiling: 1_024 },
  maximumCells: { default: 20_000_000, ceiling: 100_000_000 },
  maximumSheets: { default: 32, ceiling: 128 },
  maximumCellTextBytes: { default: 16 * 1024, ceiling: 64 * 1024 },
  sharedStringsMemoryBytes: { default: 32 * MIB, ceiling: 256 * MIB },
  maximumSharedStrings: { default: 5_000_000, ceiling: 20_000_000 },
  maximumOutputBytes: { default: 1_024 * MIB, ceiling: 4_096 * MIB },
  analysisTimeoutMilliseconds: { default: 5 * 60_000, ceiling: 30 * 60_000 },
  materializationTimeoutMilliseconds: { default: 15 * 60_000, ceiling: 60 * 60_000 },
  parserMaxOldSpaceMiB: { default: 256, ceiling: 2_048 },
};

const variables: Record<keyof DatasetImportLimits, string> = {
  maximumCompressedBytes: "NORTH_DATA_IMPORT_MAX_COMPRESSED_BYTES",
  maximumEntries: "NORTH_DATA_IMPORT_MAX_ENTRIES",
  maximumEntryBytes: "NORTH_DATA_IMPORT_MAX_ENTRY_BYTES",
  maximumUncompressedBytes: "NORTH_DATA_IMPORT_MAX_EXPANDED_BYTES",
  maximumCompressionRatio: "NORTH_DATA_IMPORT_MAX_COMPRESSION_RATIO",
  maximumRows: "NORTH_DATA_IMPORT_MAX_ROWS",
  maximumColumns: "NORTH_DATA_IMPORT_MAX_COLUMNS",
  maximumCells: "NORTH_DATA_IMPORT_MAX_CELLS",
  maximumSheets: "NORTH_DATA_IMPORT_MAX_SHEETS",
  maximumCellTextBytes: "NORTH_DATA_IMPORT_MAX_CELL_TEXT_BYTES",
  sharedStringsMemoryBytes: "NORTH_DATA_IMPORT_SHARED_STRINGS_MEMORY_BYTES",
  maximumSharedStrings: "NORTH_DATA_IMPORT_MAX_SHARED_STRINGS",
  maximumOutputBytes: "NORTH_DATA_IMPORT_MAX_OUTPUT_BYTES",
  analysisTimeoutMilliseconds: "NORTH_DATA_IMPORT_ANALYSIS_TIMEOUT_MS",
  materializationTimeoutMilliseconds: "NORTH_DATA_IMPORT_MATERIALIZATION_TIMEOUT_MS",
  parserMaxOldSpaceMiB: "NORTH_DATA_IMPORT_PARSER_MAX_OLD_SPACE_MIB",
};

/**
 * Environment overrides must be positive safe integers and are clamped to the hard ceiling;
 * anything invalid falls back to the default. There is no "unlimited" value.
 */
export function datasetImportLimits(environment: NodeJS.ProcessEnv = process.env): DatasetImportLimits {
  const result = {} as DatasetImportLimits;
  for (const key of Object.keys(bounds) as Array<keyof DatasetImportLimits>) {
    const { default: fallback, ceiling } = bounds[key];
    const parsed = Number(environment[variables[key]]);
    result[key] = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, ceiling) : fallback;
  }
  return result;
}
