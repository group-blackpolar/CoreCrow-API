import { fail } from "../../shared/errors.js";
const positiveInteger = (name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        fail(500, "ASSET_CONFIGURATION_INVALID", `${name} is invalid`);
    return value;
};
export function assetConfiguration() {
    return {
        uploadUrlTtlSeconds: positiveInteger("NORTH_ASSET_UPLOAD_URL_TTL_SECONDS", 300, 60, 900),
        readUrlTtlSeconds: positiveInteger("NORTH_ASSET_READ_URL_TTL_SECONDS", 300, 30, 900),
        defaultOrganizationStorageLimitBytes: positiveInteger("NORTH_ASSET_DEFAULT_STORAGE_LIMIT_BYTES", 10 * 1024 * 1024 * 1024, 1024 * 1024),
        maximumBytes: {
            image: positiveInteger("NORTH_ASSET_IMAGE_MAX_BYTES", 10 * 1024 * 1024),
            document: positiveInteger("NORTH_ASSET_DOCUMENT_MAX_BYTES", 50 * 1024 * 1024),
            video: positiveInteger("NORTH_ASSET_VIDEO_MAX_BYTES", 250 * 1024 * 1024),
        },
    };
}
