import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

// Organization onboarding: emailed invitations that create the account, member accounts created by an administrator,
// the per-organization storage limit and permanent deletion of content (category / subcategory / panel).
test("Organization policy", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5533?ignoreTLS=true";
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
  await new Promise<void>((resolve) => smtp.listen(5533, "127.0.0.1", resolve));
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
  const { runImportRetention } = await import("../src/modules/north/data/retention.js");
  const owner = await verifiedAccount("owner");
  const member = await verifiedAccount("member");
  const stranger = await verifiedAccount("stranger");
  const organizationId = expect(await call("POST", "/v1/organizations", owner.cookie, { name: "Policy Org", slug: `pol${prefix}` }), 201).id as string;
  const otherOrg = expect(await call("POST", "/v1/organizations", stranger.cookie, { name: "Other Policy Org", slug: `pox${prefix}` }), 201).id as string;
  const org = `/v1/organizations/${organizationId}`;
  const group = expect(await call("POST", `${org}/groups`, owner.cookie, { name: "Lectores" }), 201);
  const foreignGroup = expect(await call("POST", `/v1/organizations/${otherOrg}/groups`, stranger.cookie, { name: "Ajeno" }), 201);
  const key = (payload: object = {}) => call("POST", `${org}/invitations`, owner.cookie, { kind: "CODE", ...payload });
  const joinMember = async () => {
    const inv = expect(await key({ role: "MEMBER" }), 201);
    expect(await call("POST", "/v1/invitations/accept", member.cookie, { token: inv.token }), 200);
  };

  await t.test("built-in defaults apply until a policy is saved", async () => {
    const policy = expect(await call("GET", `${org}/policy`, owner.cookie), 200);
    assert.deepEqual(policy, { defaultMemberRole: "MEMBER", defaultGroupIds: [], importRetentionDays: null });
    assert.equal(expect(await key(), 201).role, "MEMBER");
  });
  await t.test("policy writes are validated, tenant-scoped and privileged", async () => {
    const put = (cookie: string, payload: unknown, o = org) => call("PUT", `${o.startsWith("/v1") ? o : `/v1/organizations/${o}`}/policy`, cookie, payload);
    assert.equal((await put(owner.cookie, { defaultMemberRole: "ADMIN", defaultGroupIds: [], importRetentionDays: null })).statusCode, 400);
    assert.equal((await put(owner.cookie, { defaultMemberRole: "OWNER", defaultGroupIds: [], importRetentionDays: null })).statusCode, 400);
    assert.equal((await put(owner.cookie, { defaultMemberRole: "VIEWER", defaultGroupIds: [], importRetentionDays: 0 })).statusCode, 400);
    assert.equal((await put(owner.cookie, { defaultMemberRole: "VIEWER", defaultGroupIds: [foreignGroup.id], importRetentionDays: null })).statusCode, 422);
    assert.ok([403, 404].includes((await put(stranger.cookie, { defaultMemberRole: "VIEWER", defaultGroupIds: [], importRetentionDays: null })).statusCode));
    await joinMember();
    assert.equal((await put(member.cookie, { defaultMemberRole: "VIEWER", defaultGroupIds: [], importRetentionDays: null })).statusCode, 403);
    expect(await put(owner.cookie, { defaultMemberRole: "VIEWER", defaultGroupIds: [group.id], importRetentionDays: 30 }), 200);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: "organization.policy.update" } }), 1);
  });
  await t.test("new invitations and accounts use the default role and groups; explicit choices win", async () => {
    const plain = expect(await key(), 201);
    assert.equal(plain.role, "VIEWER");
    assert.deepEqual(plain.groupIds, [group.id]);
    const explicit = expect(await key({ role: "MEMBER", groupIds: [] }), 201);
    assert.deepEqual([explicit.role, explicit.groupIds], ["MEMBER", []]);
    const created = expect(await call("POST", `${org}/members/new`, owner.cookie, { name: "Cuenta Nueva" }), 201);
    assert.equal(created.membership.role, "VIEWER");
    const grants = await prisma.organizationGroupMember.findMany({ where: { membershipId: created.membership.id } });
    assert.deepEqual(grants.map((entry) => entry.groupId), [group.id]);
  });
  await t.test("deleting a default group drops it from the policy", async () => {
    const temp = expect(await call("POST", `${org}/groups`, owner.cookie, { name: "Temporal" }), 201);
    expect(await call("PUT", `${org}/policy`, owner.cookie, { defaultMemberRole: "VIEWER", defaultGroupIds: [group.id, temp.id], importRetentionDays: 30 }), 200);
    assert.equal((await call("DELETE", `${org}/groups/${temp.id}`, owner.cookie)).statusCode, 200);
    assert.deepEqual(expect(await call("GET", `${org}/policy`, owner.cookie), 200).defaultGroupIds, [group.id]);
  });

  await t.test("retention purges old failed imports only, is idempotent and honours the opt-in", async () => {
    const dataset = expect(await call("POST", `${org}/datasets`, owner.cookie, { name: { en: "R" }, slug: "retention-data" }), 201);
    const membership = await prisma.membership.findFirstOrThrow({ where: { organizationId, userId: owner.id } });
    const make = async (label: string, status: "FAILED" | "SUCCEEDED" | "CANCELLED", ageDays: number) => {
      const job = await prisma.northDatasetImportJob.create({ data: {
        organizationId, datasetId: dataset.id, requestedBy: owner.id, requestedMembershipId: membership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(),
        requestHash: createHash("sha256").update(label).digest("hex"), filename: `${label}.xlsx`, declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n,
        declaredChecksum: "c".repeat(64), storageKey: `opaque/${label}-${prefix}`, status, scanStatus: "APPROVED",
      } });
      await prisma.northDatasetImportJob.update({ where: { id: job.id }, data: { updatedAt: new Date(Date.now() - ageDays * 86_400_000) } });
      return job.id;
    };
    const oldFailed = await make("old-failed", "FAILED", 45);
    const oldCancelled = await make("old-cancelled", "CANCELLED", 31);
    const freshFailed = await make("fresh-failed", "FAILED", 5);
    const oldSucceeded = await make("old-succeeded", "SUCCEEDED", 90); // not purgeable status: never touched
    const exists = (id: string) => prisma.northDatasetImportJob.count({ where: { id } });
    const before = await prisma.auditLog.count({ where: { organizationId, action: "NORTH_DATASET_IMPORTS_PURGED" } });
    await runImportRetention();
    assert.deepEqual([await exists(oldFailed), await exists(oldCancelled), await exists(freshFailed), await exists(oldSucceeded)], [0, 0, 1, 1]);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: "NORTH_DATASET_IMPORTS_PURGED" } }), before + 1);
    assert.equal(await runImportRetention(), 0);
    // opting out (null) stops the sweep even for very old records
    await prisma.northDatasetImportJob.update({ where: { id: freshFailed }, data: { updatedAt: new Date(Date.now() - 400 * 86_400_000) } });
    expect(await call("PUT", `${org}/policy`, owner.cookie, { defaultMemberRole: "VIEWER", defaultGroupIds: [group.id], importRetentionDays: null }), 200);
    await runImportRetention();
    assert.equal(await exists(freshFailed), 1);
  });
});
