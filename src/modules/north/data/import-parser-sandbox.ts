import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStorage } from "../../../infrastructure/object-storage.js";
import { DomainError } from "../../../shared/errors.js";
import type { DatasetImportLimits } from "./import-limits.js";

export type ParserChild = ChildProcessByStdio<null, Readable, null>;

export type ParserSandbox = {
  start(mode: "analyze" | "materialize" | "count", mappingPath?: string): ParserChild;
  mappingPath(): string;
  writeMapping(value: unknown): Promise<string>;
  cleanup(): Promise<void>;
};

/**
 * Downloads the pinned object version into a private temp directory and prepares a Node permission-model child
 * that can read only that directory, `node_modules` and the parser sources, and write only to its spill directory.
 */
export async function createParserSandbox(
  storage: ObjectStorage,
  input: { storageKey: string; storageVersionId: string; signal: AbortSignal },
  limits: DatasetImportLimits,
  label: string,
  unavailableCode: string,
): Promise<ParserSandbox> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!(major! > 22 || (major === 22 && minor! >= 13)) || !process.allowedNodeEnvironmentFlags.has("--permission"))
    throw new DomainError(503, unavailableCode, "Workbook parser sandbox requires Node 22.13 or newer");
  const directory = await mkdtemp(join(tmpdir(), `corecrow-xlsx-${label}-`));
  await chmod(directory, 0o700);
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const file = join(directory, "approved.xlsx");
    const spill = join(directory, "spill");
    const limitsFile = join(directory, "limits.json");
    await mkdir(spill, { mode: 0o700 });
    await writeFile(limitsFile, JSON.stringify(limits), { mode: 0o600 });
    await pipeline(await storage.openPrivateRead(input.storageKey, input.storageVersionId), createWriteStream(file, { mode: 0o600 }), { signal: input.signal });
    const child = fileURLToPath(new URL("./import-analysis-child.mjs", import.meta.url));
    const reader = fileURLToPath(new URL("./xlsx-stream-reader.mjs", import.meta.url));
    const readable = [directory, dirname(child), reader, await realpath(join(process.cwd(), "node_modules"))];
    const permissionArgs = [...readable.map((path) => `--allow-fs-read=${path}`), `--allow-fs-write=${spill}`];
    return {
      mappingPath: () => join(directory, "mapping.json"),
      async writeMapping(value) {
        const path = join(directory, "mapping.json");
        await writeFile(path, JSON.stringify(value), { mode: 0o600 });
        return path;
      },
      start(mode, mappingPath) {
        return spawn(
          process.execPath,
          ["--permission", ...permissionArgs, `--max-old-space-size=${limits.parserMaxOldSpaceMiB}`, child, file, mode, mappingPath ?? "-", limitsFile, spill],
          { cwd: directory, env: {}, stdio: ["ignore", "pipe", "ignore"] },
        );
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
