import { timingSafeEqual } from "node:crypto";
import { fail } from "../../shared/errors.js";
const starts = (expected) => (bytes) => bytes.length >= expected.length && expected.every((value, index) => bytes[index] === value);
export const assetFormats = Object.freeze({
    "image/jpeg": { category: "image", magic: starts([0xff, 0xd8, 0xff]) },
    "image/png": { category: "image", magic: starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    "image/gif": { category: "image", magic: (bytes) => starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])(bytes) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])(bytes) },
    "image/webp": { category: "image", magic: (bytes) => starts([0x52, 0x49, 0x46, 0x46])(bytes) && bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" },
    "application/pdf": { category: "document", magic: starts([0x25, 0x50, 0x44, 0x46, 0x2d]) },
    "video/mp4": { category: "video", magic: (bytes) => bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" },
    "video/webm": { category: "video", magic: starts([0x1a, 0x45, 0xdf, 0xa3]) },
});
export function validateAssetDeclaration(input, config) {
    const filename = input.filename.trim();
    if (!filename || filename.length > 255 || /[\\/]/.test(filename) || [...filename].some((character) => character.charCodeAt(0) < 32))
        fail(422, "ASSET_FILENAME_INVALID", "Asset filename is invalid");
    const format = assetFormats[input.mime];
    if (!format)
        fail(422, "ASSET_MIME_NOT_ALLOWED", "Asset MIME type is not allowed");
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > config.maximumBytes[format.category])
        fail(422, "ASSET_SIZE_INVALID", "Asset size exceeds the configured limit");
    const checksum = input.checksum.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(checksum))
        fail(422, "ASSET_CHECKSUM_INVALID", "Asset checksum must be SHA-256 hex");
    return { filename, mime: input.mime, size: input.size, checksum, category: format.category };
}
export function validateInspectedAsset(declared, inspected) {
    if (BigInt(inspected.size) !== declared.size)
        fail(422, "ASSET_SIZE_MISMATCH", "Uploaded asset size does not match declaration");
    if (inspected.mime !== declared.mime)
        fail(422, "ASSET_MIME_MISMATCH", "Uploaded asset MIME does not match declaration");
    if (!inspected.checksum || !/^[0-9a-f]{64}$/i.test(inspected.checksum))
        fail(422, "ASSET_CHECKSUM_UNAVAILABLE", "Object storage did not provide a verifiable SHA-256 checksum");
    const expected = Buffer.from(declared.checksum, "hex");
    const actual = Buffer.from(inspected.checksum, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        fail(422, "ASSET_CHECKSUM_MISMATCH", "Uploaded asset checksum does not match declaration");
    if (!assetFormats[declared.mime].magic(inspected.prefix))
        fail(422, "ASSET_MAGIC_MISMATCH", "Uploaded bytes do not match the declared MIME type");
}
