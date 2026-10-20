import { AsyncLocalStorage } from "node:async_hooks";

/** A platform operator reading one organization without membership (read-only; see authorization/inspection). */
export type Inspection = Readonly<{ userId: string; organizationId: string }>;
/** Where the request came from, plus what the sign-in admission decided (read by the auth route after Better Auth returns). */
export type Network = {
  ip: string | null;
  userAgent: string | null;
  /** Raw opaque device cookie sent by the browser, if any. */
  deviceToken: string | null;
  /** Filled by session admission. */
  outcome: { denied?: { status: number; code: string; message: string }; issueDeviceToken?: string };
};
type RequestContext = Readonly<{ requestId: string; inspection?: Inspection; network?: Network }>;
const storage = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(requestId: string, work: () => Promise<T>, inspection?: Inspection, network?: Network) {
  return storage.run(Object.freeze({ requestId, ...(inspection ? { inspection } : {}), ...(network ? { network } : {}) }), work);
}

export function currentRequestId() {
  return storage.getStore()?.requestId;
}

export function currentInspection() {
  return storage.getStore()?.inspection;
}

export function currentNetwork() {
  return storage.getStore()?.network;
}
