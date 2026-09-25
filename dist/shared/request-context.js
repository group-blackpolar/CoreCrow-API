import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage();
export function withRequestContext(requestId, work) {
    return storage.run(Object.freeze({ requestId }), work);
}
export function currentRequestId() {
    return storage.getStore()?.requestId;
}
