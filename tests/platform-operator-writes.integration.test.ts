import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/** ADR-0002 option C: a platform operator writing to a tenant without membership gives a reason, is audited, and the tenant can see it. */
test("platform operator writes: reason, audit event in the tenant log, reads and members unchanged", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5543?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5543, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { delete process.env.PLATFORM_OPERATOR_REASON_REQUIRED; await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `127.0.110.${(address++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const expectStatus = (response: Res, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  let signup = 10;
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    expectStatus(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: `127.0.111.${signup++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    expectStatus(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.112.${signup++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password } });
    expectStatus(login, 200);
    return { email, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
  }

  const owner = await account("owner");
  const operator = await account("operator");
  const orgId = expectStatus(await call("POST", "/v1/organizations", owner.cookie, { name: `Support ${prefix}` }), 201).id as string;
  await prisma.user.update({ where: { email: operator.email }, data: { role: "SUPERADMIN" } });
  const base = `/v1/organizations/${orgId}`;
  const events = () => prisma.auditLog.findMany({ where: { organizationId: orgId, action: "PLATFORM_OPERATOR_WRITE" }, orderBy: { createdAt: "asc" } });
  const category = (slug: string, headers?: Record<string, string>, cookie = operator.cookie) => call("POST", `${base}/categories`, cookie, { name: { en: slug }, slug }, headers);

  await t.test("without enforcement the write works, is audited once and carries no reason", async () => {
    delete process.env.PLATFORM_OPERATOR_REASON_REQUIRED;
    expectStatus(await category(`op-${prefix}-a`), 201);
    const list = await events();
    assert.equal(list.length, 1);
    assert.equal((list[0]!.metadata as { reason: string | null }).reason, null);
    assert.equal(list[0]!.actorId, (await prisma.user.findUniqueOrThrow({ where: { email: operator.email } })).id);
  });

  await t.test("a reason is recorded in the event", async () => {
    expectStatus(await category(`op-${prefix}-b`, { "x-platform-reason": "Support ticket 4821: customer asked for a category" }), 201);
    const list = await events();
    assert.equal(list.length, 2);
    assert.match((list[1]!.metadata as { reason: string }).reason, /ticket 4821/);
  });

  await t.test("with enforcement a missing or short reason is refused and nothing is written", async () => {
    process.env.PLATFORM_OPERATOR_REASON_REQUIRED = "true";
    const missing = await category(`op-${prefix}-c`);
    assert.equal(missing.statusCode, 403);
    assert.equal(missing.json().error?.code ?? missing.json().code, "PLATFORM_REASON_REQUIRED");
    assert.equal((await category(`op-${prefix}-c`, { "x-platform-reason": "short" })).statusCode, 403);
    assert.equal(await prisma.northCategory.count({ where: { organizationId: orgId, slug: `op-${prefix}-c` } }), 0);
    expectStatus(await category(`op-${prefix}-d`, { "x-platform-reason": "Reviewed with the customer on a call" }), 201);
    assert.equal((await events()).length, 3);
  });

  await t.test("members are not operators: the owner writes without reason and without an event", async () => {
    process.env.PLATFORM_OPERATOR_REASON_REQUIRED = "true";
    const before = (await events()).length;
    expectStatus(await category(`own-${prefix}`, undefined, owner.cookie), 201);
    assert.equal((await events()).length, before);
  });

  await t.test("reads by the operator are not regulated and create no event", async () => {
    process.env.PLATFORM_OPERATOR_REASON_REQUIRED = "true";
    const before = (await events()).length;
    await call("GET", `${base}/north/management-tree`, operator.cookie);
    await call("GET", `${base}/north/search?query=op`, operator.cookie);
    assert.equal((await events()).length, before);
  });

  await t.test("the tenant sees the operator writes in its own audit log", async () => {
    const log = expectStatus(await call("GET", `${base}/audit?limit=100`, owner.cookie), 200) as Array<{ action: string }>;
    assert.ok(log.some((entry) => entry.action === "PLATFORM_OPERATOR_WRITE"));
  });
});
