import {
  createS3ObjectStorage,
  UnavailableObjectStorage,
  type ObjectStorage,
} from "../../infrastructure/object-storage.js";

export * from "../../infrastructure/object-storage.js";

export function objectStorageFromEnvironment(): ObjectStorage {
  const bucket = process.env.NORTH_ASSET_S3_BUCKET;
  const region = process.env.NORTH_ASSET_S3_REGION;
  if (!bucket || !region) return new UnavailableObjectStorage();
  return createS3ObjectStorage({
    bucket,
    region,
    endpoint: process.env.NORTH_ASSET_S3_ENDPOINT,
    publicEndpoint: process.env.NORTH_ASSET_S3_PUBLIC_ENDPOINT?.trim() || undefined,
    forcePathStyle: process.env.NORTH_ASSET_S3_FORCE_PATH_STYLE === "true",
    // Deleted or rejected assets and avatars must not keep their bytes as hidden noncurrent versions.
    purgeVersions: true,
  });
}
