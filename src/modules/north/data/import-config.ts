export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type DatasetImportConfiguration = {
  maximumBytes: number;
  uploadUrlTtlSeconds: number;
};

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function datasetImportConfiguration(): DatasetImportConfiguration {
  return {
    maximumBytes: positiveInteger(process.env.NORTH_DATA_IMPORT_MAX_BYTES, 100 * 1024 * 1024),
    uploadUrlTtlSeconds: positiveInteger(process.env.NORTH_DATA_IMPORT_UPLOAD_TTL_SECONDS, 15 * 60),
  };
}
