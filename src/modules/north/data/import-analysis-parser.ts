import type { ObjectStorage } from "../../../infrastructure/object-storage.js";
import { DomainError } from "../../../shared/errors.js";
import type { DatasetImportWorkbookAnalysis } from "./import-analysis-types.js";
import { datasetImportLimits, type DatasetImportLimits } from "./import-limits.js";
import { createParserSandbox } from "./import-parser-sandbox.js";

export type DatasetImportAnalyzer = {
  analyze(input: { storageKey: string; storageVersionId: string; signal: AbortSignal }): Promise<{ parserVersion: string; workbook: DatasetImportWorkbookAnalysis }>;
};

const MAXIMUM_ANALYSIS_OUTPUT_BYTES = 8 * 1024 * 1024;

export class StreamingDatasetImportAnalyzer implements DatasetImportAnalyzer {
  constructor(private readonly storage: ObjectStorage, private readonly limits: DatasetImportLimits = datasetImportLimits()) {}

  async analyze(input: { storageKey: string; storageVersionId: string; signal: AbortSignal }) {
    const sandbox = await createParserSandbox(this.storage, input, this.limits, "analysis", "IMPORT_ANALYZER_SANDBOX_UNAVAILABLE").catch((error: unknown) => {
      if (error instanceof DomainError || input.signal.aborted) throw error;
      throw new DomainError(503, "IMPORT_ANALYZER_UNAVAILABLE", "Workbook analyzer is unavailable");
    });
    try {
      return await new Promise<{ parserVersion: string; workbook: DatasetImportWorkbookAnalysis }>((resolve, reject) => {
        const child = sandbox.start("analyze");
        const output: Buffer[] = [];
        let outputBytes = 0;
        let outputExceeded = false;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, this.limits.analysisTimeoutMilliseconds);
        const abort = () => child.kill("SIGKILL");
        input.signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > MAXIMUM_ANALYSIS_OUTPUT_BYTES) { outputExceeded = true; child.kill("SIGKILL"); return; }
          output.push(chunk);
        });
        child.once("error", reject);
        child.once("close", (code: number | null) => {
          clearTimeout(timeout); input.signal.removeEventListener("abort", abort);
          if (input.signal.aborted) return reject(input.signal.reason ?? new Error("analysis aborted"));
          if (timedOut) return reject(new DomainError(422, "IMPORT_PARSE_TIMEOUT", "Workbook analysis exceeded its time limit"));
          if (outputExceeded) return reject(new DomainError(503, "IMPORT_ANALYZER_OUTPUT_LIMIT", "Workbook analyzer response exceeded its limit"));
          try {
            const parsed = JSON.parse(Buffer.concat(output).toString("utf8")) as { ok: boolean; code?: string; parserVersion?: string; workbook?: DatasetImportWorkbookAnalysis };
            if (code === 0 && parsed.ok && parsed.parserVersion && parsed.workbook) resolve({ parserVersion: parsed.parserVersion, workbook: parsed.workbook });
            else reject(new DomainError(422, parsed.code ?? "IMPORT_ANALYZER_FAILED", "Workbook analysis failed"));
          } catch { reject(new DomainError(503, "IMPORT_ANALYZER_UNAVAILABLE", "Workbook analyzer is unavailable")); }
        });
      });
    } catch (error) {
      if (error instanceof DomainError || input.signal.aborted) throw error;
      throw new DomainError(503, "IMPORT_ANALYZER_UNAVAILABLE", "Workbook analyzer is unavailable");
    } finally {
      await sandbox.cleanup();
    }
  }
}

export class UnconfiguredDatasetImportAnalyzer implements DatasetImportAnalyzer {
  analyze(): Promise<never> { return Promise.reject(new DomainError(503, "IMPORT_ANALYZER_UNAVAILABLE", "Workbook analyzer is not configured")); }
}
