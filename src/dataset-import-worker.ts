import { prisma } from "./lib/database.js";
import {
  createDatasetImportWorkerRuntime,
  datasetImportWorkerRuntimeConfiguration,
  runDatasetImportWorkerLoop,
} from "./modules/north/data/import-worker-runtime.js";

const shutdown = new AbortController();
const stop = () => shutdown.abort();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);

try {
  const configuration = datasetImportWorkerRuntimeConfiguration();
  const worker = createDatasetImportWorkerRuntime(configuration);
  console.info("Dataset import worker started");
  await runDatasetImportWorkerLoop(worker, configuration, shutdown.signal, {
    onResult: (result) => {
      if (result !== "IDLE") console.info(`Dataset import worker cycle completed: ${result}`);
    },
    onError: () => console.error("Dataset import worker cycle failed"),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`Dataset import worker failed to start: ${message}`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await prisma.$disconnect();
  console.info("Dataset import worker stopped");
}
