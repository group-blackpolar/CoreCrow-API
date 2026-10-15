import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

// Organization onboarding: emailed invitations that create the account, member accounts created by an administrator,
// the per-organization storage limit and permanent deletion of content (category / subcategory / panel).
test("Access requests and temporary grants", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5536?ignoreTLS=true";
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
  await new Promise<void>((resolve) => smtp.listen(5536, "127.0.0.1", resolve));
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
  const { purgeExpiredGrants } = await import("../src/modules/authorization/access-requests.js");
  const owner = await verifiedAccount("owner");
  const requester = await verifiedAccount("requester");
  const delegate = await verifiedAccount("delegate");
  const stranger = await verifiedAccount("stranger");
  const organizationId = expect(await call("POST", "/v1/organizations", owner.cookie, { name: "Requests Org", slug: `req${prefix}` }), 201).id as string;
  const otherOrg = expect(await call("POST", "/v1/organizations", stranger.cookie, { name: "Other Req Org", slug: `rqx${prefix}` }), 201).id as string;
  const org = `/v1/organizations/${organizationId}`;
  const join = async (person: { cookie: string }, role: string) => {
    const key = expect(await call("POST", `${org}/invitations`, owner.cookie, { kind: "CODE", role }), 201);
    expect(await call("POST", "/v1/invitations/accept", person.cookie, { token: key.token }), 200);
  };
  await join(requester, "VIEWER");
  await join(delegate, "MEMBER");
  const ask = (cookie: string, payload: unknown, o = org) => call("POST", `${o}/access-requests`, cookie, payload);
  const decide = (cookie: string, id: string, payload: unknown, o = org) => call("POST", `${o}/access-requests/${id}/decision`, cookie, payload);
  const canReadAudit = async (cookie: string) => (await call("GET", `${org}/audit?limit=1`, cookie)).statusCode === 200;
  const grantRow = () => prisma.membershipPermissionGrant.findFirst({ where: { organizationId, permission: "audit.read", membership: { userId: requester.id } } });

  await t.test("a member can request, but duplicates, unknown and already-held permissions are refused", async () => {
    assert.equal((await ask(requester.cookie, { permission: "audit.read", reason: "ok" })).statusCode, 400); // reason too short
    assert.equal((await ask(requester.cookie, { permission: "not.a.permission", reason: "need to see the log" })).statusCode, 422);
    assert.equal((await ask(requester.cookie, { permission: "documents.read", reason: "I already have this" })).statusCode, 409);
    const created = expect(await ask(requester.cookie, { permission: "audit.read", reason: "Review the weekly activity", days: 7 }), 201);
    assert.deepEqual([created.status, created.requestedDays, created.requester.email.startsWith(`${prefix}-requester`)], ["PENDING", 7, true]);
    assert.equal((await ask(requester.cookie, { permission: "audit.read", reason: "asking twice" })).statusCode, 409);
    assert.ok([403, 404].includes((await ask(stranger.cookie, { permission: "audit.read", reason: "not a member here" })).statusCode));
  });

  await t.test("the queue is private: members see their own, only permissions.manage sees all", async () => {
    const mine = expect(await call("GET", `${org}/access-requests`, requester.cookie), 200);
    assert.equal(mine.length, 1);
    assert.equal((await call("GET", `${org}/access-requests?scope=all`, requester.cookie)).statusCode, 403);
    assert.equal(expect(await call("GET", `${org}/access-requests?scope=all&status=PENDING`, owner.cookie), 200).length, 1);
    assert.equal(expect(await call("GET", `${org}/access-requests`, delegate.cookie), 200).length, 0);
    assert.ok([403, 404].includes((await call("GET", `${org}/access-requests?scope=all`, stranger.cookie)).statusCode));
  });

  await t.test("deciding: no self-approval, no escalation, nobody without permissions.manage", async () => {
    const [request] = expect(await call("GET", `${org}/access-requests`, requester.cookie), 200);
    assert.equal((await decide(requester.cookie, request.id, { decision: "APPROVE" })).statusCode, 403);
    // a delegate that may manage permissions but does not itself hold audit.read cannot hand it out
    expect(await call("POST", `${org}/members/${delegate.id}/permission-grants`, owner.cookie, { permission: "permissions.manage" }), 201);
    const escalate = await decide(delegate.cookie, request.id, { decision: "APPROVE" });
    assert.equal(escalate.statusCode, 403);
    assert.equal(escalate.json().error.code, "PRIVILEGE_ESCALATION");
    // self-approval is refused even for a holder of permissions.manage
    expect(await call("POST", `${org}/members/${requester.id}/permission-grants`, owner.cookie, { permission: "permissions.manage" }), 201);
    assert.equal((await decide(requester.cookie, request.id, { decision: "APPROVE" })).json().error.code, "SELF_APPROVAL");
    expect(await call("DELETE", `${org}/members/${requester.id}/permission-grants/permissions.manage`, owner.cookie), 200);
    assert.equal(await canReadAudit(requester.cookie), false);
  });

  await t.test("a time-boxed approval grants access that stops when it expires, with or without the sweep", async () => {
    const [request] = expect(await call("GET", `${org}/access-requests`, requester.cookie), 200);
    const approved = expect(await decide(owner.cookie, request.id, { decision: "APPROVE", note: "for this week" }), 200);
    assert.equal(approved.status, "APPROVED");
    assert.ok(approved.grantExpiresAt && new Date(approved.grantExpiresAt).getTime() > Date.now() + 6 * 86_400_000);
    assert.equal(await canReadAudit(requester.cookie), true);
    const details = expect(await call("GET", `${org}/members/${requester.id}/permission-grants/details`, owner.cookie), 200);
    assert.ok(details.find((entry: { permission: string; expiresAt: string | null }) => entry.permission === "audit.read")?.expiresAt);
    assert.equal((await decide(owner.cookie, request.id, { decision: "DENY" })).json().error.code, "ALREADY_DECIDED");
    // time passes: the grant is still in the table but no longer counts
    await prisma.membershipPermissionGrant.updateMany({ where: { organizationId, permission: "audit.read", membership: { userId: requester.id } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await canReadAudit(requester.cookie), false);
    assert.ok(!expect(await call("GET", `${org}/members/${requester.id}/permission-grants`, owner.cookie), 200).includes("audit.read"));
    assert.equal(await purgeExpiredGrants() >= 1, true);
    assert.equal(await grantRow(), null);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: "authorization.member.permission.expired" } }), 1);
  });

  await t.test("deny, cancel, permanent approval and explicit temporary grants", async () => {
    const denied = expect(await ask(requester.cookie, { permission: "audit.read", reason: "second attempt please" }), 201);
    expect(await decide(owner.cookie, denied.id, { decision: "DENY", note: "not needed" }), 200);
    assert.equal(await canReadAudit(requester.cookie), false);
    const withdrawn = expect(await ask(requester.cookie, { permission: "billing.read", reason: "changed my mind" }), 201);
    assert.equal((await call("POST", `${org}/access-requests/${withdrawn.id}/cancel`, owner.cookie)).statusCode, 404); // not the requester
    assert.equal((await call("POST", `${org}/access-requests/${withdrawn.id}/cancel`, requester.cookie)).statusCode, 200);
    assert.equal((await decide(owner.cookie, withdrawn.id, { decision: "APPROVE" })).statusCode, 409);
    const permanent = expect(await ask(requester.cookie, { permission: "audit.read", reason: "ongoing duty", days: 30 }), 201);
    const done = expect(await decide(owner.cookie, permanent.id, { decision: "APPROVE", days: null }), 200);
    assert.equal(done.grantExpiresAt, null);
    assert.equal((await grantRow())?.expiresAt, null);
    // an administrator can also time-box a grant by hand, and re-granting without days makes it permanent again
    expect(await call("POST", `${org}/members/${requester.id}/permission-grants`, owner.cookie, { permission: "audit.read", days: 1 }), 201);
    assert.ok((await grantRow())?.expiresAt);
    expect(await call("POST", `${org}/members/${requester.id}/permission-grants`, owner.cookie, { permission: "audit.read" }), 201);
    assert.equal((await grantRow())?.expiresAt, null);
    assert.equal((await call("POST", `${org}/members/${requester.id}/permission-grants`, owner.cookie, { permission: "audit.read", days: 0 })).statusCode, 400);
  });

  await t.test("requests never cross tenants", async () => {
    const foreigner = await verifiedAccount("foreigner");
    const foreignKey = expect(await call("POST", `/v1/organizations/${otherOrg}/invitations`, stranger.cookie, { kind: "CODE", role: "VIEWER" }), 201);
    expect(await call("POST", "/v1/invitations/accept", foreigner.cookie, { token: foreignKey.token }), 200);
    const foreign = expect(await ask(foreigner.cookie, { permission: "audit.read", reason: "my own organization" }, `/v1/organizations/${otherOrg}`), 201);
    assert.ok([403, 404].includes((await decide(owner.cookie, foreign.id, { decision: "APPROVE" })).statusCode));
    assert.ok([403, 404].includes((await decide(owner.cookie, foreign.id, { decision: "APPROVE" }, `/v1/organizations/${otherOrg}`)).statusCode));
    assert.equal(await prisma.accessRequest.count({ where: { id: foreign.id, status: "PENDING" } }), 1);
  });
});
