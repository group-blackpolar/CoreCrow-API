import { AsyncLocalStorage } from "node:async_hooks";

/** A platform operator reading one organization without membership (read-only; see authorization/inspection). */
export type Inspection = Readonly<{ userId: string; organizationId: string }>;
type RequestContext = Readonly<{ requestId: string; inspection?: Inspection }>;
const storage = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(requestId: string, work: () => Promise<T>, inspection?: Inspection) {
  return storage.run(Object.freeze({ requestId, ...(inspection ? { inspection } : {}) }), work);
}

export function currentRequestId() {
  return storage.getStore()?.requestId;
}

export function currentInspection() {
  return storage.getStore()?.inspection;
}
