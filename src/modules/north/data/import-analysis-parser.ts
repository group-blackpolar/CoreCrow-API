import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { ObjectStorage } from "../../../infrastructure/object-storage.js";
import { DomainError } from "../../../shared/errors.js";
import type { DatasetImportWorkbookAnalysis } from "./import-analysis-types.js";

export type DatasetImportAnalyzer = {
  analyze(input: { storageKey: string; storageVersionId: string; signal: AbortSignal }): Promise<{ parserVersion: string; workbook: DatasetImportWorkbookAnalysis }>;
};

export class SheetJsDatasetImportAnalyzer implements DatasetImportAnalyzer {
  constructor(private readonly storage: ObjectStorage, private readonly timeoutMilliseconds = 30_000, private readonly maxOldSpaceMiB = 256) {}

  async analyze(input: { storageKey: string; storageVersionId: string; signal: AbortSignal }) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (!(major! > 22 || (major === 22 && minor! >= 13)) || !process.allowedNodeEnvironmentFlags.has("--permission"))
      throw new DomainError(503, "IMPORT_ANALYZER_SANDBOX_UNAVAILABLE", "Workbook analyzer sandbox requires Node 22.13 or newer");
    const directory = await mkdtemp(join(tmpdir(), "corecrow-xlsx-analysis-"));
    await chmod(directory, 0o700);
    const file = join(directory, "approved.xlsx");
    try {
      await pipeline(await this.storage.openPrivateRead(input.storageKey, input.storageVersionId), createWriteStream(file, { mode: 0o600 }), { signal: input.signal });
      const child = fileURLToPath(new URL("./import-analysis-child.mjs", import.meta.url));
      const fsRead = [file, directory, dirname(child), await realpath(join(process.cwd(), "node_modules"))];
      const permissionArgs = fsRead.flatMap((path) => [`--allow-fs-read=${path}`]);
      const result = await new Promise<{ parserVersion: string; workbook: DatasetImportWorkbookAnalysis }>((resolve, reject) => {
        const childProcess = spawn(process.execPath, ["--permission", ...permissionArgs, `--max-old-space-size=${this.maxOldSpaceMiB}`, child, file], {
          cwd: directory, env: {}, stdio: ["ignore", "pipe", "ignore"],
        });
        const output: Buffer[] = [];
        let outputBytes = 0;
        let outputExceeded = false;
        const timeout = setTimeout(() => childProcess.kill("SIGKILL"), this.timeoutMilliseconds);
        const abort = () => childProcess.kill("SIGKILL");
        input.signal.addEventListener("abort", abort, { once: true });
        childProcess.stdout.on("data", (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > 1024 * 1024) { outputExceeded = true; childProcess.kill("SIGKILL"); return; }
          output.push(chunk);
        });
        childProcess.once("error", reject);
        childProcess.once("close", (code: number | null) => {
          clearTimeout(timeout); input.signal.removeEventListener("abort", abort);
          if (input.signal.aborted) return reject(input.signal.reason ?? new Error("analysis aborted"));
          if (outputExceeded) return reject(new DomainError(503, "IMPORT_ANALYZER_OUTPUT_LIMIT", "Workbook analyzer response exceeded its limit"));
          try {
            const parsed = JSON.parse(Buffer.concat(output).toString("utf8")) as { ok: boolean; code?: string; parserVersion?: string; workbook?: DatasetImportWorkbookAnalysis };
            if (code === 0 && parsed.ok && parsed.parserVersion && parsed.workbook) resolve({ parserVersion: parsed.parserVersion, workbook: parsed.workbook });
            else reject(new DomainError(422, parsed.code ?? "IMPORT_ANALYZER_FAILED", "Workbook analysis failed"));
          } catch { reject(new DomainError(503, "IMPORT_ANALYZER_UNAVAILABLE", "Workbook analyzer is unavailable")); }
        });
      });
      return result;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (input.signal.aborted) throw error;
      throw new DomainError(503, "IMPORT_ANALYZER_UNAVAILABLE", "Workbook analyzer is unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class UnconfiguredDatasetImportAnalyzer implements DatasetImportAnalyzer {
  analyze(): Promise<never> { return Promise.reject(new DomainError(503, "IMPORT_ANALYZER_UNAVAILABLE", "Workbook analyzer is not configured")); }
}
