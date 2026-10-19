import type { PipelineStep } from "./pipeline-service.js";

export type PipelineRunInput = {
  source: string;
  sourceSha256: string;
  params: Record<string, unknown>;
  steps: PipelineStep[];
  datasetId: string | null;
  kind: "TEST" | "REPROCESS" | "IMPORT";
};
export type PipelineRunOutcome = { stats: Record<string, unknown>; report: Record<string, unknown> };

/**
 * Execution boundary for untrusted pipeline scripts. A real implementation MUST run the source in an isolated sandbox
 * (own process/container, CPU, memory, wall-time and temp-storage limits, no network, empty environment, no database or
 * CoreCrow credentials) and hand it data only through a CoreCrow-mediated reader. Nothing here may eval or import the source.
 */
export interface PipelineRunner {
  readonly enabled: boolean;
  run(input: PipelineRunInput): Promise<PipelineRunOutcome>;
}

export class DisabledPipelineRunner implements PipelineRunner {
  readonly enabled = false;
  async run(): Promise<PipelineRunOutcome> {
    throw new Error("Pipeline execution is disabled: no isolated runner is configured");
  }
}

let runner: PipelineRunner = new DisabledPipelineRunner();
export const currentPipelineRunner = () => runner;
/** Injection point for the isolated runner (and for tests). Production keeps the disabled runner until the sandbox exists. */
export function configurePipelineRunner(next: PipelineRunner) { runner = next; }
