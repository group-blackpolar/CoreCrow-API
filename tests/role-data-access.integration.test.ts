import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

// Organization onboarding: emailed invitations that create the account, member accounts created by an administrator,
// the per-organization storage limit and permanent deletion of content (category / subcategory / panel).
test("Role data access", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5531?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, callback) {
      let value = "";
      stream.on("data", (data) => { value += data; });
      stream.on("end", () => { messages.push(value); callback(); });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(5531, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { generatedPassword, localPartOf } = await import("../src/modules/tenancy/invitation-service.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.20.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const expect = (response: Awaited<ReturnType<typeof call>>, status: number) => {
    assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`);
    return response.json();
  };
  const cookieOf = (response: Awaited<ReturnType<typeof call>>) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const signIn = (email: string, pass: string) =>
    app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.21.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000" }, payload: { email, password: pass } });

  let signupAddress = 10;
  async function verifiedAccount(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    expect(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: `127.0.22.${signupAddress++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expect(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await signIn(email, password);
    expect(login, 200);
    return { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, email, cookie: cookieOf(login) };
  }


  await t.test("password and address formats", () => {
    assert.match(generatedPassword("shark"), /^SHARK-PASS-[A-Za-z0-9]{10}$/);
    assert.notEqual(generatedPassword("shark"), generatedPassword("shark"));
    assert.equal(localPartOf("Samuel Pérez"), "samuel");
    assert.equal(localPartOf("  "), "user");
  });
  const owner = await verifiedAccount("owner");
  const viewer = await verifiedAccount("viewer");
  const stranger = await verifiedAccount("stranger");
  const organizationId = expect(await call("POST", "/v1/organizations", owner.cookie, { name: "Role Org", slug: `rda${prefix}` }), 201).id as string;
  const otherOrg = expect(await call("POST", "/v1/organizations", stranger.cookie, { name: "Other Org", slug: `rdb${prefix}` }), 201).id as string;
  const org = `/v1/organizations/${organizationId}`;
  const code = expect(await call("POST", `${org}/invitations`, owner.cookie, { kind: "CODE", role: "VIEWER" }), 201);
  expect(await call("POST", "/v1/invitations/accept", viewer.cookie, { token: code.token }), 200);
  const ds = expect(await call("POST", `${org}/datasets`, owner.cookie, { name: { en: "D", es: "D" }, slug: "role-data" }), 201);
  const foreign = expect(await call("POST", `/v1/organizations/${otherOrg}/datasets`, stranger.cookie, { name: { en: "F", es: "F" }, slug: "foreign-data" }), 201);
  const query = (cookie: string, orgId = organizationId, id = ds.id) => call("POST", `/v1/organizations/${orgId}/datasets/${id}/query`, cookie, { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }] });
  const grant = (cookie: string, payload: unknown, orgId = organizationId) => call("POST", `/v1/organizations/${orgId}/north/role-data-access`, cookie, payload);

  await t.test("a viewer cannot query before the grant", async () => {
    assert.equal((await query(viewer.cookie)).statusCode, 403);
  });
  await t.test("a viewer cannot grant itself access", async () => {
    assert.equal((await grant(viewer.cookie, { role: "VIEWER", datasetIds: [ds.id] })).statusCode, 403);
    assert.equal((await query(viewer.cookie)).statusCode, 403);
  });
  await t.test("owner grants the role in one step; viewer is authorized (409 = dataset has no data yet), idempotent", async () => {
    const first = expect(await grant(owner.cookie, { role: "VIEWER", datasetIds: [ds.id] }), 200);
    assert.deepEqual([first.capabilityGranted, first.rulesCreated], [true, 1]);
    assert.equal((await query(viewer.cookie)).statusCode, 409);
    const again = expect(await grant(owner.cookie, { role: "VIEWER", datasetIds: [ds.id, ds.id] }), 200);
    assert.deepEqual([again.capabilityGranted, again.rulesCreated], [false, 0]);
    assert.equal(await prisma.northDatasetAcl.count({ where: { datasetId: ds.id, principalType: "ROLE", role: "VIEWER" } }), 1);
    assert.equal(await prisma.northRoleGrant.count({ where: { organizationId, role: "VIEWER", capability: "north.data.query" } }), 1);
  });
  await t.test("the grant never confers edit, export or management", async () => {
    assert.equal((await call("PATCH", `${org}/datasets/${ds.id}`, viewer.cookie, { name: { en: "x", es: "x" } })).statusCode, 403);
    assert.equal((await call("POST", `${org}/datasets/${ds.id}/acl`, viewer.cookie, { effect: "ALLOW", principalType: "ALL_MEMBERS" })).statusCode, 403);
  });
  await t.test("tenant isolation: foreign datasets and foreign users are rejected", async () => {
    assert.equal((await grant(owner.cookie, { role: "VIEWER", datasetIds: [foreign.id] })).statusCode, 404);
    assert.ok([403, 404].includes((await grant(owner.cookie, { role: "VIEWER", datasetIds: [ds.id] }, otherOrg)).statusCode));
    assert.equal((await query(viewer.cookie, otherOrg, foreign.id)).statusCode, 404);
    assert.equal((await query(stranger.cookie, organizationId, ds.id)).statusCode, 404);
  });
  await t.test("privileged roles and unknown input are rejected", async () => {
    assert.equal((await grant(owner.cookie, { role: "ADMIN", datasetIds: [ds.id] })).statusCode, 422);
    assert.equal((await grant(owner.cookie, { role: "VIEWER", datasetIds: [] })).statusCode, 400);
    assert.equal((await grant(owner.cookie, { role: "VIEWER", datasetIds: [ds.id], capability: "north.data.manage" })).statusCode, 400);
  });
});
