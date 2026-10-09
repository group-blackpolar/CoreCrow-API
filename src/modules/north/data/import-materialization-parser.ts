import { StringDecoder } from "node:string_decoder";
import type { ObjectStorage } from "../../../infrastructure/object-storage.js";
import { DomainError } from "../../../shared/errors.js";
import type { NorthDatasetFieldType } from "../../../lib/database.js";
import { datasetImportLimits, type DatasetImportLimits } from "./import-limits.js";
import { createParserSandbox, type ParserSandbox } from "./import-parser-sandbox.js";

export type MaterializationColumn = {
  sourceOrdinal: number;
  action: "MAP" | "CREATE";
  fieldId: string;
  canonicalType: NorthDatasetFieldType;
  nullable: boolean;
};

export type MaterializedRow = Record<string, string | number | boolean | null>;

/**
 * Two phases over the same pinned object version:
 *  1. a validating pass that coerces every row and discards the output, so a bad workbook fails before anything is
 *     written and the exact row count is known;
 *  2. a streaming pass that delivers bounded batches, in source order, to `rows`. The next batch is not read until the
 *     previous `rows` promise settles (the child blocks on a full pipe); a rejection stops the child.
 * `begin` runs between the phases with the row count and parser version.
 */
export type DatasetImportMaterializationSink = {
  begin(summary: { parserVersion: string; rowCount: number }): Promise<void>;
  rows(batch: MaterializedRow[]): Promise<void>;
};

export type DatasetImportMaterializer = {
  materialize(
    input: {
      storageKey: string;
      storageVersionId: string;
      sheetOrdinal: number;
      headerRow: number;
      columns: MaterializationColumn[];
      signal: AbortSignal;
    },
    sink: DatasetImportMaterializationSink,
  ): Promise<{ parserVersion: string; rowCount: number; maxRssKiB?: number }>;
};

type Summary = { parserVersion: string; rowCount: number; maxRssKiB?: number };
const MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;

export class StreamingDatasetImportMaterializer implements DatasetImportMaterializer {
  constructor(private readonly storage: ObjectStorage, private readonly limits: DatasetImportLimits = datasetImportLimits()) {}

  async materialize(input: Parameters<DatasetImportMaterializer["materialize"]>[0], sink: DatasetImportMaterializationSink) {
    const sandbox = await createParserSandbox(this.storage, input, this.limits, "materialization", "IMPORT_MATERIALIZER_SANDBOX_UNAVAILABLE").catch((error: unknown) => {
      if (error instanceof DomainError || input.signal.aborted) throw error;
      throw new DomainError(503, "IMPORT_MATERIALIZER_UNAVAILABLE", "Workbook materializer is unavailable");
    });
    try {
      const mappingPath = await sandbox.writeMapping({ sheetOrdinal: input.sheetOrdinal, headerRow: input.headerRow, columns: input.columns });
      const counted = await this.run(sandbox, "count", mappingPath, input.signal, async () => {});
      await sink.begin({ parserVersion: counted.parserVersion, rowCount: counted.rowCount });
      const streamed = await this.run(sandbox, "materialize", mappingPath, input.signal, (rows) => sink.rows(rows));
      if (streamed.rowCount !== counted.rowCount) throw new DomainError(503, "IMPORT_MATERIALIZER_UNAVAILABLE", "Workbook materializer is unavailable");
      return streamed;
    } finally {
      await sandbox.cleanup();
    }
  }

  private async run(sandbox: ParserSandbox, mode: "count" | "materialize", mappingPath: string, signal: AbortSignal, onRows: (rows: MaterializedRow[]) => Promise<void>): Promise<Summary> {
    const child = sandbox.start(mode, mappingPath);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, this.limits.materializationTimeoutMilliseconds);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    const closed = new Promise<number | null>((resolve) => { child.once("close", resolve); child.once("error", () => resolve(null)); });
    let failureCode: string | undefined;
    let summary: Summary | undefined;
    let received = 0;
    let rowCount = 0;
    const outputCeiling = this.limits.maximumOutputBytes + MAXIMUM_LINE_BYTES;
    try {
      const decoder = new StringDecoder("utf8");
      let carry = "";
      const handle = async (line: string) => {
        if (!line) return;
        const message = JSON.parse(line) as { ok?: boolean; code?: string; done?: boolean; rows?: MaterializedRow[]; parserVersion?: string; rowCount?: number; maxRssKiB?: number };
        if (message.ok === false) failureCode = message.code ?? "IMPORT_MATERIALIZATION_FAILED";
        else if (message.done && message.parserVersion && typeof message.rowCount === "number") summary = { parserVersion: message.parserVersion, rowCount: message.rowCount, maxRssKiB: message.maxRssKiB };
        else if (Array.isArray(message.rows)) {
          rowCount += message.rows.length;
          if (rowCount > this.limits.maximumRows) throw new DomainError(422, "IMPORT_ROW_LIMIT_EXCEEDED", "Workbook exceeds the allowed row count");
          await onRows(message.rows);
        }
      };
      for await (const chunk of child.stdout) {
        received += (chunk as Buffer).byteLength;
        if (received > outputCeiling) throw new DomainError(422, "IMPORT_MATERIALIZER_OUTPUT_LIMIT", "Workbook materialization exceeded its output limit");
        carry += decoder.write(chunk as Buffer);
        for (let newline = carry.indexOf("\n"); newline >= 0; newline = carry.indexOf("\n")) {
          const line = carry.slice(0, newline);
          carry = carry.slice(newline + 1);
          await handle(line);
        }
        if (carry.length > MAXIMUM_LINE_BYTES) throw new DomainError(422, "IMPORT_MATERIALIZER_OUTPUT_LIMIT", "Workbook materialization exceeded its output limit");
      }
      await handle(carry + decoder.end());
    } catch (error) {
      child.kill("SIGKILL");
      await closed;
      if (signal.aborted) throw signal.reason ?? new Error("materialization aborted");
      if (error instanceof SyntaxError) throw new DomainError(503, "IMPORT_MATERIALIZER_UNAVAILABLE", "Workbook materializer is unavailable");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
    const code = await closed;
    if (signal.aborted) throw signal.reason ?? new Error("materialization aborted");
    if (timedOut) throw new DomainError(422, "IMPORT_PARSE_TIMEOUT", "Workbook materialization exceeded its time limit");
    if (failureCode) throw new DomainError(422, failureCode, "Workbook materialization failed");
    const done = summary as Summary | undefined;
    if (code !== 0 || !done || (mode === "materialize" && done.rowCount !== rowCount)) throw new DomainError(503, "IMPORT_MATERIALIZER_UNAVAILABLE", "Workbook materializer is unavailable");
    return done;
  }
}
