import { AsyncLocalStorage } from "node:async_hooks";

type RequestContext = Readonly<{ requestId: string }>;
const storage = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(requestId: string, work: () => Promise<T>) {
  return storage.run(Object.freeze({ requestId }), work);
}

export function currentRequestId() {
  return storage.getStore()?.requestId;
}
