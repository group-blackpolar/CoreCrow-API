import { fail } from "../../../shared/errors.js";

/** A dashboard fires a dozen heavy aggregates at once; running them all together makes every one miss the timeout. Excess waits here, outside any transaction. */
export const MAX_CONCURRENT = 4;
/** Waiting longer than this only ends in a proxy timeout with the query still to run: refuse early with a retryable error instead. */
export const MAX_WAIT_MS = 20_000;

let running = 0;
const waiting: Array<() => void> = [];

export type GateOptions = {
  /** Bounds the queue for callers that are not authenticated (RM-012): beyond it the request is refused instead of piling up. */
  maxWaiting?: number;
  /** Aborted when the caller goes away: work it is no longer waiting for is never started. */
  signal?: AbortSignal;
  maxWaitMs?: number;
};

const abandoned = () => fail(499, "REQUEST_ABORTED", "The request was cancelled before the query started");

/**
 * Runs `work` in one of the MAX_CONCURRENT slots. A freed slot is handed straight to the oldest waiter, so a newcomer can
 * never take it in between. Work that already started is not interrupted: identical queries share one execution.
 */
export async function gated<T>(work: () => Promise<T>, { maxWaiting = Infinity, signal, maxWaitMs = MAX_WAIT_MS }: GateOptions = {}): Promise<T> {
  if (signal?.aborted) abandoned();
  if (running < MAX_CONCURRENT) running += 1;
  else {
    if (waiting.length >= maxWaiting) fail(503, "SERVICE_BUSY", "Too many concurrent queries, retry shortly");
    await new Promise<void>((resolve, reject) => {
      const leave = (settle: () => void) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); settle(); };
      const start = () => leave(resolve);
      const giveUp = (refuse: () => never) => {
        waiting.splice(waiting.indexOf(start), 1);
        leave(() => { try { refuse(); } catch (error) { reject(error); } });
      };
      const onAbort = () => giveUp(abandoned);
      const timer = setTimeout(() => giveUp(() => fail(503, "SERVICE_BUSY", "Too many concurrent queries, retry shortly")), maxWaitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(start);
    });
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next(); else running -= 1;
  }
}
