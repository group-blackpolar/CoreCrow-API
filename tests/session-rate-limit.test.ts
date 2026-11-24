import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { sessionBucket } from "../src/contracts/route.js";

const cookie = (token: string) => `better-auth.session_token=${token}`;
const A = `${"a".repeat(32)}.${"x".repeat(20)}`, B = `${"b".repeat(32)}.${"y".repeat(20)}`;

test("sessionBucket: one bucket per session cookie, the IP otherwise, and a malformed cookie falls back to the IP", () => {
  const same = (headers: { cookie?: string }, ip: string) => sessionBucket({ headers, ip });
  assert.equal(same({ cookie: cookie(A) }, "1.1.1.1"), same({ cookie: cookie(A) }, "2.2.2.2"), "the same session is one bucket wherever it comes from");
  assert.notEqual(same({ cookie: cookie(A) }, "1.1.1.1"), same({ cookie: cookie(B) }, "1.1.1.1"), "two sessions behind one IP are two buckets");
  assert.equal(same({}, "3.3.3.3"), "ip:3.3.3.3");
  assert.equal(same({ cookie: cookie("short") }, "3.3.3.3"), "ip:3.3.3.3");
  assert.equal(same({ cookie: `other=1; __Secure-better-auth.session_token=${A}; x=2` }, "9.9.9.9"), same({ cookie: cookie(A) }, "9.9.9.9"));
  assert.ok(!sessionBucket({ headers: { cookie: cookie(A) }, ip: "1.1.1.1" }).includes(A), "the token itself is never used as the key");
});

test("a class behind one IP: each session has its own allowance, and anonymous callers still share the IP bucket", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.get("/x", { config: { rateLimit: { max: 3, timeWindow: "1 minute", keyGenerator: sessionBucket } } }, async () => ({ ok: true }));
  const hit = (headers: Record<string, string> = {}) => app.inject({ method: "GET", url: "/x", remoteAddress: "10.0.0.1", headers }).then((r) => r.statusCode);
  assert.deepEqual([await hit({ cookie: cookie(A) }), await hit({ cookie: cookie(A) }), await hit({ cookie: cookie(A) }), await hit({ cookie: cookie(A) })], [200, 200, 200, 429]);
  assert.deepEqual([await hit({ cookie: cookie(B) }), await hit({ cookie: cookie(B) }), await hit({ cookie: cookie(B) })], [200, 200, 200], "another student on the same IP is not throttled by the first");
  assert.deepEqual([await hit(), await hit(), await hit(), await hit()], [200, 200, 200, 429], "no session: the IP bucket");
});
