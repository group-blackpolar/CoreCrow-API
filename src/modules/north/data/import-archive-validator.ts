import type { Readable } from "node:stream";
import { DomainError } from "../../../shared/errors.js";

export type DatasetImportArchiveValidationInput = {
  filename: string;
  size: number;
  checksum: string;
  openPrivateRead: () => Promise<Readable>;
  signal: AbortSignal;
};

export interface DatasetImportArchiveValidator {
  validate(input: DatasetImportArchiveValidationInput): Promise<"APPROVED">;
}

export class UnconfiguredDatasetImportArchiveValidator implements DatasetImportArchiveValidator {
  validate(): Promise<"APPROVED"> {
    return Promise.reject(new DomainError(
      503,
      "IMPORT_ARCHIVE_VALIDATOR_UNAVAILABLE",
      "ZIP and OOXML security validation is not configured",
    ));
  }
}
