/** Hard ceiling for one XLSX upload; aligned with ClamAV StreamMaxLength (256M) and the nginx storage location. */
export const IMPORT_MAX_BYTES_CEILING = 256 * 1024 * 1024;
export const IMPORT_MAX_BYTES_DEFAULT = 100 * 1024 * 1024;

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
    maximumBytes: Math.min(positiveInteger(process.env.NORTH_DATA_IMPORT_MAX_BYTES, IMPORT_MAX_BYTES_DEFAULT), IMPORT_MAX_BYTES_CEILING),
    uploadUrlTtlSeconds: positiveInteger(process.env.NORTH_DATA_IMPORT_UPLOAD_TTL_SECONDS, 15 * 60),
  };
}
