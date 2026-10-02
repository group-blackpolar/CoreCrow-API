import { hostname } from "node:os";
import { NorthDatasetImportWorker, type DatasetImportWorkerConfiguration } from "./import-worker.js";
import { SecureXlsxArchiveValidator } from "./import-archive-validator.js";
import { datasetImportMalwareScannerFromEnvironment } from "./import-malware-scanner.js";
import { datasetImportStorageFromEnvironment } from "./import-storage.js";
import { NorthDatasetImportAnalysisWorker } from "./import-analysis-worker.js";
import { SheetJsDatasetImportAnalyzer, type DatasetImportAnalyzer } from "./import-analysis-parser.js";
import type { ObjectStorage } from "../../../infrastructure/object-storage.js";
import type { DatasetImportMalwareScanner } from "./import-malware-scanner.js";
import type { DatasetImportArchiveValidator } from "./import-archive-validator.js";
import { NorthDatasetImportMaterializationWorker } from "./import-materialization-worker.js";
import { SheetJsDatasetImportMaterializer, type DatasetImportMaterializer } from "./import-materialization-parser.js";

const MEBIBYTE = 1024 * 1024;

export type DatasetImportWorkerRuntimeConfiguration = {
  workerId: string;
  pollMilliseconds: number;
  worker: DatasetImportWorkerConfiguration;
};

export type DatasetImportWorkerRunner = {
  runOnce(): Promise<string>;
};

export type DatasetImportWorkerLoopHooks = {
  onResult?: (result: string) => void;
  onError?: () => void;
};

export type DatasetImportWorkerRuntimeDependencies = {
  storage?: ObjectStorage;
  scanner?: DatasetImportMalwareScanner;
  archiveValidator?: DatasetImportArchiveValidator;
  analyzer?: DatasetImportAnalyzer;
  materializer?: DatasetImportMaterializer;
};

function configurationError(name: string, reason: string): never {
  throw new Error(`Dataset import worker configuration ${name} ${reason}`);
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) configurationError(name, "is required");
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    configurationError(name, `must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function optionalBoolean(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name];
  if (value === undefined || value === "") return;
  if (value !== "true" && value !== "false") configurationError(name, "must be true or false");
}

function validateEndpoint(environment: NodeJS.ProcessEnv) {
  const value = environment.NORTH_DATA_IMPORT_S3_ENDPOINT?.trim();
  if (!value) return;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error();
  } catch {
    configurationError("NORTH_DATA_IMPORT_S3_ENDPOINT", "must be an HTTP(S) URL");
  }
}

function validateScannerEndpoint(environment: NodeJS.ProcessEnv) {
  const socketPath = environment.NORTH_DATA_IMPORT_CLAMAV_SOCKET?.trim();
  const host = environment.NORTH_DATA_IMPORT_CLAMAV_HOST?.trim();
  const port = environment.NORTH_DATA_IMPORT_CLAMAV_PORT?.trim();
  if (socketPath && (host || port))
    configurationError("ClamAV endpoint", "must use either a socket or host and port, not both");
  if (!socketPath && !host) configurationError("ClamAV endpoint", "is required");
  if (host && !port) configurationError("NORTH_DATA_IMPORT_CLAMAV_PORT", "is required with the host");
  if (!host && port) configurationError("NORTH_DATA_IMPORT_CLAMAV_HOST", "is required with the port");
  if (port) {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535)
      configurationError("NORTH_DATA_IMPORT_CLAMAV_PORT", "must be an integer between 1 and 65535");
  }
}

export function datasetImportWorkerRuntimeConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): DatasetImportWorkerRuntimeConfiguration {
  required(environment, "DATABASE_URL");
  required(environment, "NORTH_DATA_IMPORT_S3_BUCKET");
  required(environment, "NORTH_DATA_IMPORT_S3_REGION");
  optionalBoolean(environment, "NORTH_DATA_IMPORT_S3_FORCE_PATH_STYLE");
  validateEndpoint(environment);
  validateScannerEndpoint(environment);

  const leaseMilliseconds = integer(environment, "NORTH_DATA_IMPORT_WORKER_LEASE_MS", 60_000, 5_000, 15 * 60_000);
  const heartbeatMilliseconds = integer(environment, "NORTH_DATA_IMPORT_WORKER_HEARTBEAT_MS", 15_000, 1_000, 5 * 60_000);
  if (heartbeatMilliseconds >= leaseMilliseconds)
    configurationError("NORTH_DATA_IMPORT_WORKER_HEARTBEAT_MS", "must be less than the lease duration");

  return {
    workerId: environment.NORTH_DATA_IMPORT_WORKER_ID?.trim() || `${hostname()}:${process.pid}`,
    pollMilliseconds: integer(environment, "NORTH_DATA_IMPORT_WORKER_POLL_MS", 1_000, 100, 60_000),
    worker: {
      leaseMilliseconds,
      heartbeatMilliseconds,
      retryDelayMilliseconds: integer(
        environment,
        "NORTH_DATA_IMPORT_WORKER_RETRY_DELAY_MS",
        60_000,
        1_000,
        24 * 60 * 60_000,
      ),
      maximumBytes: integer(
        environment,
        "NORTH_DATA_IMPORT_MAX_BYTES",
        50 * MEBIBYTE,
        1,
        50 * MEBIBYTE,
      ),
    },
  };
}

export async function createDatasetImportWorkerRuntime(
  configuration: DatasetImportWorkerRuntimeConfiguration,
  dependencies: DatasetImportWorkerRuntimeDependencies = {},
) {
  const storage = dependencies.storage ?? datasetImportStorageFromEnvironment();
  await storage.assertImmutableVersioning();
  const security = new NorthDatasetImportWorker(configuration.workerId, {
    storage,
    scanner: dependencies.scanner
      ?? datasetImportMalwareScannerFromEnvironment({ maximumBytes: configuration.worker.maximumBytes }),
    archiveValidator: dependencies.archiveValidator ?? new SecureXlsxArchiveValidator(),
    configuration: configuration.worker,
  });
  const analysis = new NorthDatasetImportAnalysisWorker(
    configuration.workerId,
    dependencies.analyzer ?? new SheetJsDatasetImportAnalyzer(storage),
    { leaseMilliseconds: configuration.worker.leaseMilliseconds, heartbeatMilliseconds: configuration.worker.heartbeatMilliseconds, retryDelayMilliseconds: configuration.worker.retryDelayMilliseconds },
  );
  const materialization = new NorthDatasetImportMaterializationWorker(
    configuration.workerId,
    dependencies.materializer ?? new SheetJsDatasetImportMaterializer(storage),
    { leaseMilliseconds: configuration.worker.leaseMilliseconds, heartbeatMilliseconds: configuration.worker.heartbeatMilliseconds, retryDelayMilliseconds: configuration.worker.retryDelayMilliseconds },
  );
  return {
    async runOnce() {
      const result = await security.runOnce();
      if (result !== "IDLE") return result;
      const analysisResult = await analysis.runOnce();
      return analysisResult === "IDLE" ? materialization.runOnce() : analysisResult;
    },
  } satisfies DatasetImportWorkerRunner;
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runDatasetImportWorkerLoop(
  runner: DatasetImportWorkerRunner,
  configuration: Pick<DatasetImportWorkerRuntimeConfiguration, "pollMilliseconds">,
  signal: AbortSignal,
  hooks: DatasetImportWorkerLoopHooks = {},
) {
  while (!signal.aborted) {
    try {
      const result = await runner.runOnce();
      hooks.onResult?.(result);
    } catch {
      hooks.onError?.();
    }
    if (!signal.aborted) await wait(configuration.pollMilliseconds, signal);
  }
}
