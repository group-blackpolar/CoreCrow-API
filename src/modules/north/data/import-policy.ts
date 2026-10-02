import { fail } from "../../../shared/errors.js";
import type { ObjectInspection } from "../../../infrastructure/object-storage.js";
import { XLSX_MIME, type DatasetImportConfiguration } from "./import-config.js";

export type DatasetImportDeclaration = {
  filename: string;
  mime: string;
  size: number;
  checksum: string;
};

export function validateDatasetImportDeclaration(
  input: DatasetImportDeclaration,
  configuration: DatasetImportConfiguration,
) {
  const filename = input.filename.trim();
  const mime = input.mime.trim().toLowerCase();
  const checksum = input.checksum.trim().toLowerCase();
  if (!filename.toLowerCase().endsWith(".xlsx"))
    fail(422, "IMPORT_FILE_TYPE_UNSUPPORTED", "Only XLSX imports are supported");
  if (mime !== XLSX_MIME)
    fail(422, "IMPORT_MIME_UNSUPPORTED", "Only the XLSX MIME type is supported");
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > configuration.maximumBytes)
    fail(422, "IMPORT_SIZE_INVALID", "Import size is outside the configured limit");
  if (!/^[0-9a-f]{64}$/.test(checksum))
    fail(422, "IMPORT_CHECKSUM_INVALID", "Import checksum must be a SHA-256 hex digest");
  return { filename, mime, size: input.size, checksum };
}

export function validateUploadedDatasetImport(
  declared: { declaredMime: string; declaredSize: bigint; declaredChecksum: string },
  inspected: ObjectInspection,
) {
  if (inspected.size !== Number(declared.declaredSize))
    fail(422, "IMPORT_SIZE_MISMATCH", "Uploaded import size does not match its declaration");
  if (!inspected.checksum || inspected.checksum.toLowerCase() !== declared.declaredChecksum)
    fail(422, "IMPORT_CHECKSUM_MISMATCH", "Uploaded import checksum does not match its declaration");
  if (!inspected.mime || inspected.mime.toLowerCase() !== declared.declaredMime)
    fail(422, "IMPORT_MIME_MISMATCH", "Uploaded import MIME type does not match its declaration");
  const prefix = inspected.prefix;
  if (prefix.length < 4 || prefix[0] !== 0x50 || prefix[1] !== 0x4b || prefix[2] !== 0x03 || prefix[3] !== 0x04)
    fail(422, "IMPORT_MAGIC_INVALID", "Uploaded import is not an XLSX ZIP container");
}
