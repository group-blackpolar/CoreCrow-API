import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise, type Entry } from "yauzl";
import { DomainError } from "../../../shared/errors.js";
import { datasetImportLimits, type DatasetImportLimits } from "./import-limits.js";

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

export type DatasetImportArchiveLimits = Pick<DatasetImportLimits, "maximumCompressedBytes" | "maximumEntries" | "maximumEntryBytes" | "maximumUncompressedBytes" | "maximumCompressionRatio">;

const requiredParts = new Set([
  "[content_types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
]);

const forbiddenPartPrefixes = [
  "customui/",
  "customxml/",
  "xl/activex/",
  "xl/dialogsheets/",
  "xl/embeddings/",
  "xl/externallinks/",
  "xl/macrosheets/",
  "xl/oleobjects/",
  "xl/querytables/",
  "xl/webextensions/",
];
const forbiddenParts = new Set(["xl/connections.xml"]);
const maximumCapturedControlBytes = 256 * 1024;

const reject = (code: string, message: string): never => {
  throw new DomainError(422, code, message);
};

function assertEntryMetadata(entry: Entry, limits: DatasetImportArchiveLimits) {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0)
    reject("IMPORT_ARCHIVE_ENCRYPTED", "Encrypted XLSX archives are not accepted");
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
    reject("IMPORT_ARCHIVE_COMPRESSION_UNSUPPORTED", "XLSX archive compression is not supported");
  if (entry.uncompressedSize > limits.maximumEntryBytes)
    reject("IMPORT_ARCHIVE_LIMIT_EXCEEDED", "An XLSX archive entry exceeds its allowed size");
  if (entry.compressedSize === 0 && entry.uncompressedSize > 0)
    reject("IMPORT_ARCHIVE_LIMIT_EXCEEDED", "An XLSX archive entry has an invalid compression ratio");
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maximumCompressionRatio)
    reject("IMPORT_ARCHIVE_LIMIT_EXCEEDED", "An XLSX archive entry exceeds its allowed compression ratio");
}

function assertPassivePart(fileName: string) {
  const normalized = fileName.toLowerCase();
  if (
    normalized.endsWith("vbaproject.bin") ||
    normalized.endsWith("vbaprojectsignature.bin") ||
    forbiddenParts.has(normalized) ||
    forbiddenPartPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) reject("IMPORT_OOXML_ACTIVE_CONTENT", "Active or externally linked OOXML content is not accepted");
}

async function consumeEntry(
  stream: Readable,
  entry: Entry,
  signal: AbortSignal,
  capture: boolean,
) {
  let actualSize = 0;
  let xmlTail = "";
  const relationshipPart = entry.fileName.toLowerCase().endsWith(".rels");
  let capturedBytes = 0;
  const captured: Buffer[] = [];
  for await (const value of stream) {
    if (signal.aborted) throw signal.reason ?? new Error("Dataset import archive validation aborted");
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    actualSize += chunk.byteLength;
    const probe = (xmlTail + chunk.toString("utf8")).toUpperCase();
    if (probe.includes("<!DOCTYPE") || probe.includes("<!ENTITY"))
      reject("IMPORT_OOXML_ACTIVE_CONTENT", "DTD and entity declarations are not accepted in OOXML");
    if (relationshipPart && /TARGETMODE\s*=\s*["']EXTERNAL["']/.test(probe))
      reject("IMPORT_OOXML_ACTIVE_CONTENT", "External OOXML relationships are not accepted");
    xmlTail = probe.slice(-128);
    if (capture && capturedBytes < maximumCapturedControlBytes) {
      const remaining = maximumCapturedControlBytes - capturedBytes;
      const selected = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      captured.push(selected);
      capturedBytes += selected.byteLength;
    }
  }
  if (actualSize !== entry.uncompressedSize)
    reject("IMPORT_ARCHIVE_INVALID", "XLSX archive entry size did not match its directory record");
  return capture ? Buffer.concat(captured).toString("utf8") : undefined;
}

export class SecureXlsxArchiveValidator implements DatasetImportArchiveValidator {
  constructor(private readonly limits: DatasetImportArchiveLimits = datasetImportLimits()) {}

  async validate(input: DatasetImportArchiveValidationInput): Promise<"APPROVED"> {
    if (input.size > this.limits.maximumCompressedBytes)
      reject("IMPORT_ARCHIVE_LIMIT_EXCEEDED", "XLSX archive exceeds its allowed compressed size");

    const directory = await mkdtemp(join(tmpdir(), "corecrow-xlsx-"));
    const archivePath = join(directory, "import.xlsx");
    try {
      let compressedBytes = 0;
      const limiter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          compressedBytes += chunk.byteLength;
          if (compressedBytes > input.size || compressedBytes > this.limits.maximumCompressedBytes)
            callback(new DomainError(422, "IMPORT_SIZE_MISMATCH", "Uploaded import size does not match its declaration"));
          else callback(null, chunk);
        },
      });
      await pipeline(
        await input.openPrivateRead(),
        limiter,
        createWriteStream(archivePath, { mode: 0o600 }),
        { signal: input.signal },
      );
      if (compressedBytes !== input.size)
        reject("IMPORT_SIZE_MISMATCH", "Uploaded import size does not match its declaration");

      const zip = await openPromise(archivePath, {
        autoClose: true,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      });
      const seen = new Set<string>();
      let entries = 0;
      let totalUncompressedBytes = 0;
      let hasWorksheet = false;
      let contentTypes: string | undefined;
      let rootRelationships: string | undefined;
      let workbook: string | undefined;
      let workbookRelationships: string | undefined;
      try {
        for await (const entry of zip.eachEntry()) {
          if (input.signal.aborted) throw input.signal.reason ?? new Error("Dataset import archive validation aborted");
          entries += 1;
          if (entries > this.limits.maximumEntries)
            reject("IMPORT_ARCHIVE_LIMIT_EXCEEDED", "XLSX archive contains too many entries");
          if (entry.fileName.length > 512 || entry.fileName.includes("\0"))
            reject("IMPORT_ARCHIVE_INVALID", "XLSX archive contains an invalid entry name");
          const name = entry.fileName.toLowerCase();
          if (seen.has(name)) reject("IMPORT_ARCHIVE_INVALID", "XLSX archive contains duplicate entry names");
          seen.add(name);
          assertPassivePart(entry.fileName);
          assertEntryMetadata(entry, this.limits);
          totalUncompressedBytes += entry.uncompressedSize;
          if (totalUncompressedBytes > this.limits.maximumUncompressedBytes)
            reject("IMPORT_ARCHIVE_LIMIT_EXCEEDED", "XLSX archive exceeds its allowed expanded size");
          if (entry.fileName.endsWith("/")) continue;

          const isXml = name.endsWith(".xml") || name.endsWith(".rels");
          const isRelationship = name.endsWith(".rels");
          if (isRelationship && entry.uncompressedSize > maximumCapturedControlBytes)
            reject("IMPORT_ARCHIVE_LIMIT_EXCEEDED", "An OOXML relationships part exceeds its allowed size");
          const shouldCapture = requiredParts.has(name) || isRelationship || /^xl\/worksheets\/sheet[^/]*\.xml$/.test(name);
          const value = await consumeEntry(await zip.openReadStreamPromise(entry), entry, input.signal, shouldCapture);
          if (isRelationship && /TARGETMODE\s*=\s*["']EXTERNAL["']/i.test(value ?? ""))
            reject("IMPORT_OOXML_ACTIVE_CONTENT", "External OOXML relationships are not accepted");
          if (isXml && value === undefined) continue;
          if (name === "[content_types].xml") contentTypes = value;
          else if (name === "_rels/.rels") rootRelationships = value;
          else if (name === "xl/workbook.xml") workbook = value;
          else if (name === "xl/_rels/workbook.xml.rels") workbookRelationships = value;
          else if (/^xl\/worksheets\/sheet[^/]*\.xml$/.test(name)) {
            hasWorksheet = true;
            if (!/<(?:[A-Za-z_][\w.-]*:)?worksheet\b/i.test(value ?? ""))
              reject("IMPORT_OOXML_INVALID", "OOXML worksheet content is invalid");
          }
        }
      } finally {
        zip.close();
      }

      if (![...requiredParts].every((part) => seen.has(part)) || !hasWorksheet)
        reject("IMPORT_OOXML_INVALID", "XLSX archive is missing required OOXML parts");
      if (!/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml/i.test(contentTypes ?? ""))
        reject("IMPORT_OOXML_INVALID", "OOXML content types do not declare a macro-free workbook");
      if (!/officeDocument/i.test(rootRelationships ?? ""))
        reject("IMPORT_OOXML_INVALID", "OOXML package relationships are invalid");
      if (!/<(?:[A-Za-z_][\w.-]*:)?workbook\b/i.test(workbook ?? "") || !/<(?:[A-Za-z_][\w.-]*:)?sheets\b/i.test(workbook ?? ""))
        reject("IMPORT_OOXML_INVALID", "OOXML workbook content is invalid");
      if (!/worksheet/i.test(workbookRelationships ?? ""))
        reject("IMPORT_OOXML_INVALID", "OOXML workbook relationships are invalid");
      return "APPROVED";
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (input.signal.aborted) throw input.signal.reason ?? error;
      throw new DomainError(422, "IMPORT_ARCHIVE_INVALID", "XLSX archive is invalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
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
