import assert from "node:assert/strict";
import test from "node:test";
import { gated, MAX_CONCURRENT } from "../src/modules/north/data/query-gate.js";

/** Occupies every slot until `release` is called. */
function fillSlots() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const running = Array.from({ length: MAX_CONCURRENT }, () => gated(() => held));
  return { release: async () => { release(); await Promise.all(running); } };
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("work whose caller went away while queued never runs", async () => {
  const slots = fillSlots();
  let executed = 0;
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const queued = controllers.map((c) => gated(async () => { executed += 1; }, { signal: c.signal }));
  const kept = gated(async () => "kept");
  for (const c of controllers) c.abort();
  await Promise.all(queued.map((promise) => assert.rejects(promise, code("REQUEST_ABORTED"))));
  await slots.release();
  assert.equal(await kept, "kept", "a caller still waiting is served");
  assert.equal(executed, 0);
});

test("an already abandoned request is refused without taking a slot", async () => {
  const controller = new AbortController();
  controller.abort();
  let executed = false;
  await assert.rejects(gated(async () => { executed = true; }, { signal: controller.signal }), code("REQUEST_ABORTED"));
  assert.equal(executed, false);
});

test("waiting is bounded in time and, for anonymous callers, in length", async () => {
  const slots = fillSlots();
  await assert.rejects(gated(async () => 1, { maxWaitMs: 20 }), code("SERVICE_BUSY"));
  await assert.rejects(gated(async () => 1, { maxWaiting: 0 }), code("SERVICE_BUSY"));
  await slots.release();
  assert.equal(await gated(async () => 2), 2, "slots are free again after refusals");
});

test("no more than the allowed number of queries run at once, even as slots change hands, and failures free theirs", async () => {
  let active = 0;
  let peak = 0;
  const job = (fails: boolean) => gated(async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (fails) throw new Error("boom");
  }).catch(() => undefined);
  const jobs: Array<Promise<unknown>> = [];
  for (let i = 0; i < 60; i += 1) { jobs.push(job(i % 5 === 0)); if (i % 7 === 0) await new Promise((resolve) => setImmediate(resolve)); }
  await Promise.all(jobs);
  assert.equal(peak, MAX_CONCURRENT);
  assert.equal(await gated(async () => 3), 3);
});
