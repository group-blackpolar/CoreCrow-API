import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { ObjectStorage } from "../../../infrastructure/object-storage.js";
import { DomainError } from "../../../shared/errors.js";
import type { NorthDatasetFieldType } from "../../../lib/database.js";

export type MaterializationColumn = {
  sourceOrdinal: number;
  action: "MAP" | "CREATE";
  fieldId: string;
  canonicalType: NorthDatasetFieldType;
  nullable: boolean;
};

export type DatasetImportMaterializer = {
  materialize(input: {
    storageKey: string;
    storageVersionId: string;
    sheetOrdinal: number;
    headerRow: number;
    columns: MaterializationColumn[];
    signal: AbortSignal;
  }): Promise<{ parserVersion: string; rows: Array<Record<string, string | number | boolean | null>> }>;
};

export class SheetJsDatasetImportMaterializer implements DatasetImportMaterializer {
  constructor(private readonly storage: ObjectStorage, private readonly timeoutMilliseconds = 60_000, private readonly maxOldSpaceMiB = 384) {}

  async materialize(input: Parameters<DatasetImportMaterializer["materialize"]>[0]) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (!(major! > 22 || (major === 22 && minor! >= 13)) || !process.allowedNodeEnvironmentFlags.has("--permission"))
      throw new DomainError(503, "IMPORT_MATERIALIZER_SANDBOX_UNAVAILABLE", "Workbook materializer sandbox requires Node 22.13 or newer");
    const directory = await mkdtemp(join(tmpdir(), "corecrow-xlsx-materialization-"));
    await chmod(directory, 0o700);
    const file = join(directory, "approved.xlsx");
    const mappingFile = join(directory, "mapping.json");
    try {
      await pipeline(await this.storage.openPrivateRead(input.storageKey, input.storageVersionId), createWriteStream(file, { mode: 0o600 }), { signal: input.signal });
      await writeFile(mappingFile, JSON.stringify({ sheetOrdinal: input.sheetOrdinal, headerRow: input.headerRow, columns: input.columns }), { mode: 0o600 });
      const child = fileURLToPath(new URL("./import-analysis-child.mjs", import.meta.url));
      const fsRead = [file, mappingFile, directory, dirname(child), await realpath(join(process.cwd(), "node_modules"))];
      const permissionArgs = fsRead.flatMap((path) => [`--allow-fs-read=${path}`]);
      return await new Promise<{ parserVersion: string; rows: Array<Record<string, string | number | boolean | null>> }>((resolve, reject) => {
        const childProcess = spawn(process.execPath, ["--permission", ...permissionArgs, `--max-old-space-size=${this.maxOldSpaceMiB}`, child, file, "materialize", mappingFile], {
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
          if (outputBytes > 64 * 1024 * 1024) { outputExceeded = true; childProcess.kill("SIGKILL"); return; }
          output.push(chunk);
        });
        childProcess.once("error", reject);
        childProcess.once("close", (code: number | null) => {
          clearTimeout(timeout);
          input.signal.removeEventListener("abort", abort);
          if (input.signal.aborted) return reject(input.signal.reason ?? new Error("materialization aborted"));
          if (outputExceeded) return reject(new DomainError(422, "IMPORT_MATERIALIZER_OUTPUT_LIMIT", "Workbook materialization exceeded its output limit"));
          try {
            const parsed = JSON.parse(Buffer.concat(output).toString("utf8")) as { ok: boolean; code?: string; parserVersion?: string; rows?: Array<Record<string, string | number | boolean | null>> };
            if (code === 0 && parsed.ok && parsed.parserVersion && Array.isArray(parsed.rows)) resolve({ parserVersion: parsed.parserVersion, rows: parsed.rows });
            else reject(new DomainError(422, parsed.code ?? "IMPORT_MATERIALIZATION_FAILED", "Workbook materialization failed"));
          } catch { reject(new DomainError(503, "IMPORT_MATERIALIZER_UNAVAILABLE", "Workbook materializer is unavailable")); }
        });
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (input.signal.aborted) throw error;
      throw new DomainError(503, "IMPORT_MATERIALIZER_UNAVAILABLE", "Workbook materializer is unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

