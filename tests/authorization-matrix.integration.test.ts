import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/**
 * RM-082: cross-cutting controls are tested per route, from the live OpenAPI, not by hand.
 *  - Coverage: the set of public routes must equal the allowlist below; a new public route needs a deliberate review.
 *  - No session: no authenticated route may answer 2xx, 3xx or 5xx.
 *  - Foreign tenant: a user of another organization gets no 2xx/3xx/5xx on any organization route.
 *  - Blocked network: the owner, calling from outside the organization's allow rule, gets no 2xx/3xx/5xx on any organization route.
 * Dummy identifiers make id-based routes answer 404 by design; the value of the matrix is the organization-level routes
 * (lists, trees, search, navigation) that would answer 200 if a gate were missing (R-006).
 */
const PUBLIC_ROUTES = [
  "GET /v1/commerce/products",
  "GET /v1/identity/config",
  "GET /v1/organizations/resolve/{slug}",
  "GET /v1/public/showcases/{organizationSlug}/navigation",
  "GET /v1/public/showcases/{organizationSlug}/resolve",
  "POST /v1/admin/sign-in",
  "POST /v1/contact",
  "POST /v1/identity/verification/confirm",
  "POST /v1/identity/verification/send",
  "POST /v1/invitations/accept-new",
  "POST /v1/invitations/validate",
  "POST /v1/public/showcases/{organizationSlug}/panels/{panelId}/analytics-bindings/{bindingId}/results",
];
/** Routes allowed to answer outside the organization's network or to non-members, with the reason. Keep empty unless justified. */
const EXCEPTIONS: Record<string, string> = {};

test("authorization matrix: every route against no session, foreign tenant and blocked network", { skip: !process.env.TEST_DATABASE_URL, timeout: 900_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5541?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5541, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let counter = 0;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown, ip?: string) => {
    const address = ip ?? `127.0.${100 + (Math.floor(counter / 250) % 100)}.${(counter % 250) + 1}`;
    counter += 1;
    return app.inject({ method, url, remoteAddress: address, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  };
  type Res = Awaited<ReturnType<typeof call>>;
  const expectStatus = (response: Res, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  let signup = 10;
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    expectStatus(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: `127.0.101.${signup++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    expectStatus(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.102.${signup++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password } });
    expectStatus(login, 200);
    return { cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
  }

  const owner = await account("owner");
  const outsider = await account("outsider");
  const orgId = expectStatus(await call("POST", "/v1/organizations", owner.cookie, { name: `Matrix ${prefix}` }), 201).id as string;
  expectStatus(await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` }), 201);

  const spec = app.swagger() as unknown as { paths: Record<string, Record<string, { security?: unknown[] }>> };
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).filter(([m]) => ["get", "post", "put", "patch", "delete"].includes(m)).map(([m, op]) => ({
      key: `${m.toUpperCase()} ${path}`,
      method: m.toUpperCase() as Method,
      path,
      isPublic: Array.isArray(op.security) && op.security.length === 0,
      orgScoped: path.includes("{organizationId}"),
    })));
  type Operation = (typeof operations)[number];
  assert.ok(operations.length > 200, "the OpenAPI document lists the routes");

  await t.test("coverage: the public routes are exactly the reviewed allowlist", () => {
    assert.deepEqual(operations.filter((o) => o.isPublic).map((o) => o.key).sort(), [...PUBLIC_ROUTES].sort(),
      "A public route was added or removed: review it and update PUBLIC_ROUTES in this test");
  });

  const fill = (path: string) => path.replace("{organizationId}", orgId).replace(/\{[^}]+\}/g, "cmmatrix0000000000000000");
  const bad = (status: number) => status < 400 || status >= 500;
  const body = (op: Operation) => (op.method === "GET" || op.method === "DELETE" ? undefined : {});
  async function sweep(label: string, list: Operation[], as: (op: Operation, n: number) => Promise<Res>) {
    const violations: string[] = [];
    let n = 0;
    for (const op of list) {
      if (EXCEPTIONS[op.key]) continue;
      const response = await as(op, n++);
      if (bad(response.statusCode)) violations.push(`${op.key} -> ${response.statusCode}`);
    }
    assert.deepEqual(violations, [], `${label}: routes that answered 2xx, 3xx or 5xx`);
  }

  await t.test("no session", () => sweep("no session", operations.filter((o) => !o.isPublic), (op) => call(op.method, fill(op.path), undefined, body(op))));
  await t.test("foreign tenant", () => sweep("foreign tenant", operations.filter((o) => o.orgScoped), (op) => call(op.method, fill(op.path), outsider.cookie, body(op))));
  await t.test("blocked network", async () => {
    expectStatus(await call("POST", `/v1/organizations/${orgId}/security/ips`, owner.cookie, { kind: "ALLOW", cidr: "127.0.0.0/8" }), 201);
    try {
      await sweep("blocked network", operations.filter((o) => o.orgScoped && !o.path.includes("/security/ips")),
        (op, n) => call(op.method, fill(op.path), owner.cookie, body(op), `8.8.${Math.floor(n / 250)}.${(n % 250) + 1}`));
    } finally {
      await prisma.securityIpRule.deleteMany({ where: { organizationId: orgId } });
    }
  });
});
