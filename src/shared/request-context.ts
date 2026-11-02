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
/** ADR-0002 (option C): a platform operator writing to a tenant without membership gives a reason and is audited. */
export type OperatorContext = Readonly<{ reason?: string; mutating: boolean }>;
type RequestContext = Readonly<{ requestId: string; inspection?: Inspection; network?: Network; operator?: OperatorContext; operatorAudited: Set<string> }>;
const storage = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(requestId: string, work: () => Promise<T>, inspection?: Inspection, network?: Network, operator?: OperatorContext) {
  return storage.run(Object.freeze({ requestId, operatorAudited: new Set<string>(), ...(inspection ? { inspection } : {}), ...(network ? { network } : {}), ...(operator ? { operator } : {}) }), work);
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

export function currentOperator() {
  return storage.getStore()?.operator;
}

/** True the first time `key` is seen in this request, so an operator write is audited once per request and organization. */
export function firstOperatorAudit(key: string) {
  const store = storage.getStore();
  if (!store || store.operatorAudited.has(key)) return false;
  store.operatorAudited.add(key);
  return true;
}
