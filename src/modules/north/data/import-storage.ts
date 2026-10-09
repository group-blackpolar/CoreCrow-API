import {
  createS3ObjectStorage,
  UnavailableObjectStorage,
  type ObjectStorage,
} from "../../../infrastructure/object-storage.js";

export function datasetImportStorageFromEnvironment(): ObjectStorage {
  const bucket = process.env.NORTH_DATA_IMPORT_S3_BUCKET;
  const region = process.env.NORTH_DATA_IMPORT_S3_REGION;
  if (!bucket || !region) return new UnavailableObjectStorage();
  return createS3ObjectStorage({
    bucket,
    region,
    endpoint: process.env.NORTH_DATA_IMPORT_S3_ENDPOINT,
    publicEndpoint: process.env.NORTH_DATA_IMPORT_S3_PUBLIC_ENDPOINT?.trim() || undefined,
    forcePathStyle: process.env.NORTH_DATA_IMPORT_S3_FORCE_PATH_STYLE === "true",
  });
}
