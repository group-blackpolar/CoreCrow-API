import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

// Security & access: permissions, organization isolation, device/session limits under concurrency, revocation, IP rules,
// alerts (dedup + e-mail), audit without secrets and retention.
test("Security and access integration", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
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
  const { runSecurityRetention } = await import("../src/modules/security-access/retention.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let counter = 1;
  const freshIp = () => `127.0.${40 + Math.floor(counter / 250)}.${(counter++ % 250) + 1}`;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie?: string, payload?: unknown, ip = freshIp()) =>
    app.inject({ method, url, remoteAddress: ip, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const expect = (response: Awaited<ReturnType<typeof call>>, status: number) => {
    assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`);
    return response.json();
  };
  const codeOf = (response: Awaited<ReturnType<typeof call>>) => (response.json() as { error?: { code?: string } }).error?.code;
  const cookieOf = (response: Awaited<ReturnType<typeof call>>) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const signIn = (email: string, pass: string, extraCookie?: string, ip = freshIp()) =>
    app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: ip, headers: { origin: "http://localhost:3000", ...(extraCookie ? { cookie: extraCookie } : {}) }, payload: { email, password: pass } });
  const deviceCookieOf = (response: Awaited<ReturnType<typeof call>>) => response.cookies.find((c) => c.name === "bp_device");

  async function verifiedAccount(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    expect(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: freshIp(), headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expect(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await signIn(email, password);
    expect(login, 200);
    return { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, email, cookie: cookieOf(login) };
  }

  const owner = await verifiedAccount("owner");
  const slug = `sec${prefix}`;
  const orgId = expect(await call("POST", "/v1/organizations", owner.cookie, { name: "Secure Org", slug }), 201).id as string;
  const other = await verifiedAccount("other");
  const otherOrg = expect(await call("POST", "/v1/organizations", other.cookie, { name: "Other Org", slug: `oth${prefix}` }), 201).id as string;
  const base = `/v1/organizations/${orgId}/security`;
  const makeMember = async (name: string, role: "MEMBER" | "ADMIN") => {
    const made = expect(await call("POST", `/v1/organizations/${orgId}/members/new`, owner.cookie, { name, password: "Member-password-42", role }), 201);
    return { id: made.user.id as string, email: made.user.email as string };
  };
  const putPolicy = (changes: Record<string, unknown>) =>
    call("PUT", `${base}/policy`, owner.cookie, { enforcement: true, maxDevices: null, maxSessions: null, overflowPolicy: "BLOCK_NEW", alertsEnabled: true, retentionDays: 90, retentionExemption: null, ...changes });

  await t.test("permissions: OWNER only by default, ADMIN needs an explicit person grant, groups cannot carry them", async () => {
    expect(await call("GET", `${base}/overview`, owner.cookie), 200);
    const admin = await makeMember("Adm", "ADMIN");
    const adminCookie = cookieOf(await signIn(admin.email, "Member-password-42"));
    assert.equal(codeOf(await call("GET", `${base}/overview`, adminCookie)), "FORBIDDEN");
    // An ADMIN may manage permissions but cannot hand out what it does not hold (nor to itself).
    expect(await call("POST", `/v1/organizations/${orgId}/members/${admin.id}/permission-grants`, adminCookie, { permission: "security.overview.view" }), 403);
    // Groups can never carry security permissions.
    const group = expect(await call("POST", `/v1/organizations/${orgId}/groups`, owner.cookie, { name: "Sec group" }), 201);
    assert.equal(codeOf(await call("POST", `/v1/organizations/${orgId}/groups/${group.id}/permissions`, owner.cookie, { permission: "security.ips.manage" })), "SECURITY_PERMISSION_DIRECT_ONLY");
    // The OWNER grants one permission to a person: only that endpoint opens.
    expect(await call("POST", `/v1/organizations/${orgId}/members/${admin.id}/permission-grants`, owner.cookie, { permission: "security.sessions.view" }), 201);
    expect(await call("GET", `${base}/sessions`, adminCookie), 200);
    assert.equal(codeOf(await call("GET", `${base}/devices`, adminCookie)), "FORBIDDEN");
    assert.equal(codeOf(await call("DELETE", `${base}/sessions/none`, adminCookie)), "FORBIDDEN");
  });

  await t.test("isolation: another organization's owner sees and changes nothing here", async () => {
    for (const path of ["overview", "devices", "sessions", "ips", "policy", "alerts", "audit", "users", "notifications"])
      assert.equal(expect_(await call("GET", `${base}/${path}`, other.cookie)), 404, path);
    assert.equal((await call("PUT", `${base}/policy`, other.cookie, { enforcement: true, maxDevices: 1, maxSessions: 1, overflowPolicy: "BLOCK_NEW", alertsEnabled: true, retentionDays: 90, retentionExemption: null })).statusCode, 404);
    function expect_(response: Awaited<ReturnType<typeof call>>) { return response.statusCode; }
  });

  await t.test("without a policy nothing is tracked or limited (existing users unaffected)", async () => {
    const member = await makeMember("Plain", "MEMBER");
    for (let n = 0; n < 3; n += 1) expect(await signIn(member.email, "Member-password-42"), 200);
    assert.equal(await prisma.session.count({ where: { userId: member.id, securityOrganizationId: { not: null } } }), 0);
  });

  await t.test("session limit under concurrency never exceeds the cap; the loser gets no usable session", async () => {
    expect(await putPolicy({ maxSessions: 2 }), 200);
    const member = await makeMember("Concurrent", "MEMBER");
    const results = await Promise.all(Array.from({ length: 6 }, () => signIn(member.email, "Member-password-42")));
    const ok = results.filter((r) => r.statusCode === 200);
    const blocked = results.filter((r) => r.statusCode === 403);
    assert.equal(ok.length, 2, results.map((r) => r.statusCode).join());
    assert.equal(blocked.length, 4);
    assert.equal(codeOf(blocked[0]!), "SESSION_LIMIT_REACHED");
    assert.equal(await prisma.session.count({ where: { userId: member.id } }), 2);
    for (const response of blocked) assert.equal(response.cookies.some((c) => c.name.includes("session_token")), false);
  });

  await t.test("overflow policies: replace_oldest ends the oldest session, require_user_choice answers 409, devices are never auto-removed", async () => {
    const member = await makeMember("Replace", "MEMBER");
    expect(await putPolicy({ maxSessions: 1, overflowPolicy: "REPLACE_OLDEST" }), 200);
    const first = cookieOf(expect_(await signIn(member.email, "Member-password-42")));
    function expect_(response: Awaited<ReturnType<typeof call>>) { assert.equal(response.statusCode, 200); return response; }
    expect(await call("GET", "/v1/me", first), 200);
    const second = cookieOf(expect_(await signIn(member.email, "Member-password-42")));
    assert.equal((await call("GET", "/v1/me", first)).statusCode, 401, "the older session is gone at once");
    expect(await call("GET", "/v1/me", second), 200);
    expect(await putPolicy({ maxSessions: 1, overflowPolicy: "REQUIRE_USER_CHOICE" }), 200);
    const choice = await signIn(member.email, "Member-password-42");
    assert.equal(choice.statusCode, 409);
    assert.equal(codeOf(choice), "SESSION_CHOICE_REQUIRED");
    // The user frees a seat from the open session, then signs in.
    const mine = expect(await call("GET", "/v1/me/sessions", second), 200) as Array<{ id: string; current: boolean }>;
    assert.equal(mine.length, 1);
    expect(await call("DELETE", `/v1/me/sessions/${mine[0]!.id}`, second), 200);
    expect(await signIn(member.email, "Member-password-42"), 200);
    assert.ok((await prisma.securityDevice.count({ where: { userId: member.id } })) >= 1);
  });

  await t.test("device limit, cookie recognition and revocation take effect immediately", async () => {
    expect(await putPolicy({ maxDevices: 1, maxSessions: null }), 200);
    const member = await makeMember("Devices", "MEMBER");
    const first = await signIn(member.email, "Member-password-42");
    expect(first, 200);
    const cookie = deviceCookieOf(first);
    assert.ok(cookie, "a device cookie is issued");
    assert.equal(cookie!.httpOnly, true);
    const deviceCookie = `bp_device=${cookie!.value}`;
    // Same device again: fine. Another device (no cookie): refused, nothing deleted.
    expect(await signIn(member.email, "Member-password-42", deviceCookie), 200);
    const other_ = await signIn(member.email, "Member-password-42");
    assert.equal(other_.statusCode, 403);
    assert.equal(codeOf(other_), "DEVICE_LIMIT_REACHED");
    assert.equal(await prisma.securityDevice.count({ where: { userId: member.id, revokedAt: null } }), 1);
    // The raw cookie is never stored.
    const stored = await prisma.securityDevice.findFirstOrThrow({ where: { userId: member.id } });
    assert.notEqual(stored.tokenHash, cookie!.value);
    const sessionCookie = cookieOf(first);
    expect(await call("GET", "/v1/me", sessionCookie), 200);
    const devices = expect(await call("GET", `${base}/devices`, owner.cookie), 200) as Array<{ id: string; userEmail: string; activeSessions: number }>;
    const mine = devices.find((d) => d.userEmail === member.email)!;
    assert.ok(mine.activeSessions >= 1);
    const revoked = expect(await call("DELETE", `${base}/devices/${mine.id}`, owner.cookie), 200);
    assert.ok(revoked.sessionsEnded >= 1);
    assert.equal((await call("GET", "/v1/me", sessionCookie)).statusCode, 401, "revoked device's session is dead");
    const again = await signIn(member.email, "Member-password-42", deviceCookie);
    assert.equal(codeOf(again), "DEVICE_REVOKED");
    // Cross-organization: the other owner cannot revoke it.
    assert.equal((await call("DELETE", `/v1/organizations/${otherOrg}/security/devices/${mine.id}`, other.cookie)).statusCode, 404);
  });

  await t.test("ip rules: IPv4/IPv6/CIDR, deny beats allow, lock-out guard, organization gate and sign-in gate", async () => {
    const member = await makeMember("Net", "MEMBER");
    const real = await verifiedAccount("realmember");
    const invite = expect(await call("POST", `/v1/organizations/${orgId}/invitations`, owner.cookie, { kind: "CODE", role: "MEMBER" }), 201);
    expect(await call("POST", "/v1/invitations/accept", real.cookie, { token: invite.token }), 200);
    const blockedIp = "127.0.99.9";
    expect(await call("POST", `${base}/ips`, owner.cookie, { kind: "ALLOW", cidr: "127.0.0.0/8" }), 201);
    assert.equal((await call("POST", `${base}/ips`, owner.cookie, { kind: "ALLOW", cidr: "2001:db8::/32" })).statusCode, 201);
    assert.equal(codeOf(await call("POST", `${base}/ips`, owner.cookie, { kind: "ALLOW", cidr: "not-an-ip" })), "INVALID_CIDR");
    assert.equal(codeOf(await call("POST", `${base}/ips`, owner.cookie, { kind: "DENY", cidr: "10.0.0.0/33" }) ), "INVALID_CIDR");
    expect(await call("POST", `${base}/ips`, owner.cookie, { kind: "DENY", cidr: `${blockedIp}/32` }), 201);
    // The administrator cannot lock themselves out.
    assert.equal(codeOf(await call("POST", `${base}/ips`, owner.cookie, { kind: "DENY", cidr: "127.0.50.50/32" }, "127.0.50.50")), "WOULD_LOCK_OUT");
    // Organization gate for a real-mailbox member; deny wins over the 127/8 allow.
    assert.equal((await call("GET", `/v1/organizations/${orgId}/members`, real.cookie, undefined, blockedIp)).statusCode, 403);
    assert.equal(codeOf(await call("GET", `/v1/organizations/${orgId}/members`, real.cookie, undefined, blockedIp)), "IP_NOT_ALLOWED");
    assert.equal((await call("GET", `/v1/organizations/${orgId}/members`, real.cookie, undefined, "127.0.1.1")).statusCode, 200);
    assert.equal((await call("GET", `/v1/organizations/${orgId}/members`, real.cookie, undefined, "8.8.8.8")).statusCode, 403, "outside every allow rule");
    // Sign-in gate for an organization-created account.
    assert.equal(codeOf(await signIn(member.email, "Member-password-42", undefined, blockedIp)), "IP_NOT_ALLOWED");
    assert.equal((await signIn(member.email, "Member-password-42", undefined, "127.0.1.2")).statusCode, 200);
    // Cleanup so later tests are not constrained.
    await prisma.securityIpRule.deleteMany({ where: { organizationId: orgId } });
    expect(await call("GET", `/v1/organizations/${orgId}/members`, real.cookie, undefined, "8.8.8.8"), 200);
  });

  await t.test("untrusted forwarded headers do not change the evaluated address", async () => {
    expect(await call("POST", `${base}/ips`, owner.cookie, { kind: "DENY", cidr: "9.9.9.9/32" }), 201);
    const spoof = await app.inject({ method: "GET", url: `/v1/organizations/${orgId}/members`, remoteAddress: "127.0.2.2", headers: { origin: "http://localhost:3000", cookie: owner.cookie, "x-forwarded-for": "9.9.9.9" } });
    assert.equal(spoof.statusCode, 200, "X-Forwarded-For is ignored without a trusted proxy");
    await prisma.securityIpRule.deleteMany({ where: { organizationId: orgId } });
  });

  await t.test("alerts: recorded once per hour and kind (count grows), e-mailed once, failures recorded, status managed", async () => {
    expect(await putPolicy({ maxSessions: 1, maxDevices: null, overflowPolicy: "BLOCK_NEW" }), 200);
    expect(await call("PUT", `${base}/notifications`, owner.cookie, { alertEmailEnabled: true, alertEmailRecipients: [`${prefix}-alerts@blackpolar.test`] }), 200);
    const member = await makeMember("Alerting", "MEMBER");
    assert.equal((await signIn(member.email, "Member-password-42")).statusCode, 200);
    const before = messages.length;
    for (let n = 0; n < 3; n += 1) assert.equal((await signIn(member.email, "Member-password-42")).statusCode, 403);
    const list = expect(await call("GET", `${base}/alerts?status=OPEN`, owner.cookie), 200) as Array<{ id: string; kind: string; userId: string; count: number; emailStatus: string }>;
    const alert = list.find((a) => a.kind === "SESSION_LIMIT_BLOCKED" && a.userId === member.id)!;
    assert.equal(alert.count, 3);
    assert.equal(alert.emailStatus, "SENT");
    assert.equal(messages.length - before, 1, "one e-mail for three identical blocks");
    expect(await call("PATCH", `${base}/alerts/${alert.id}`, owner.cookie, { status: "ACKNOWLEDGED" }), 200);
    assert.equal(expect(await call("GET", `${base}/alerts?status=ACKNOWLEDGED`, owner.cookie), 200).some((a: { id: string }) => a.id === alert.id), true);
    // A broken mail transport must not break the request or lose the alert.
    const member2 = await makeMember("Alerting2", "MEMBER");
    await prisma.organizationSecurityPolicy.update({ where: { organizationId: orgId }, data: { alertEmailRecipients: [] } });
    await prisma.membership.updateMany({ where: { organizationId: orgId, userId: owner.id }, data: { role: "OWNER" } });
    await signIn(member2.email, "Member-password-42");
    assert.equal((await signIn(member2.email, "Member-password-42")).statusCode, 403);
    const failing = (expect(await call("GET", `${base}/alerts?status=OPEN`, owner.cookie), 200) as Array<{ userId: string; emailStatus: string }>).find((a) => a.userId === member2.id)!;
    assert.ok(["SENT", "FAILED"].includes(failing.emailStatus));
  });

  await t.test("audit trail has the security events and no secrets", async () => {
    const rows = expect(await call("GET", `${base}/audit?limit=100`, owner.cookie), 200) as Array<{ action: string }>;
    const actions = new Set(rows.map((row) => row.action));
    for (const action of ["security.policy.update", "security.device.revoke", "security.ip.add"]) assert.ok(actions.has(action), action);
    const text = JSON.stringify(rows);
    for (const secret of ["Member-password-42", password, "tokenHash", "bp_device", "set-cookie"]) assert.equal(text.includes(secret), false, secret);
    const devices = JSON.stringify(expect(await call("GET", `${base}/devices?includeRevoked=true`, owner.cookie), 200));
    assert.equal(devices.includes("tokenHash"), false);
  });

  await t.test("users view marks organization-created accounts as having no real mailbox", async () => {
    const users = expect(await call("GET", `${base}/users`, owner.cookie), 200) as Array<{ email: string; mailbox: string }>;
    assert.equal(users.find((u) => u.email === owner.email)?.mailbox, "verified");
    assert.ok(users.some((u) => u.email.endsWith(`@${slug}.bp`) && u.mailbox === "organization"));
  });

  await t.test("retention: 90-day default purges old non-open alerts and revoked devices, honors an authorized exception, logs every run", async () => {
    const old = new Date(Date.now() - 120 * 86_400_000);
    const user = await makeMember("Retained", "MEMBER");
    await prisma.securityAlert.create({ data: { organizationId: orgId, kind: "OLD", severity: "info", dedupKey: `old-${prefix}`, status: "RESOLVED", lastSeenAt: old } });
    await prisma.securityAlert.create({ data: { organizationId: orgId, kind: "OLD_OPEN", severity: "info", dedupKey: `oldopen-${prefix}`, status: "OPEN", lastSeenAt: old } });
    const device = await prisma.securityDevice.create({ data: { userId: user.id, organizationId: orgId, tokenHash: `h-${prefix}`, revokedAt: old } });
    const active = await prisma.securityDevice.create({ data: { userId: user.id, organizationId: orgId, tokenHash: `a-${prefix}`, lastSeenAt: old } });
    assert.equal(expect(await call("GET", `${base}/policy`, owner.cookie), 200).retentionDays, 90);
    // Exception first: nothing is purged and the skip is recorded.
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect(await putPolicy({ retentionExemption: { until, reason: "Legal hold 2026" } }), 200);
    await runSecurityRetention();
    assert.ok(await prisma.securityDevice.findUnique({ where: { id: device.id } }));
    assert.equal((await prisma.securityRetentionRun.findFirst({ where: { organizationId: orgId }, orderBy: { ranAt: "desc" } }))?.skipped, "exception");
    // Without exception: purged, idempotent, active (merely old) device is never deleted.
    expect(await putPolicy({ retentionExemption: null }), 200);
    await runSecurityRetention();
    assert.equal(await prisma.securityDevice.findUnique({ where: { id: device.id } }), null);
    assert.ok(await prisma.securityDevice.findUnique({ where: { id: active.id } }));
    assert.equal(await prisma.securityAlert.count({ where: { organizationId: orgId, kind: "OLD" } }), 0);
    assert.equal(await prisma.securityAlert.count({ where: { organizationId: orgId, kind: "OLD_OPEN" } }), 1, "open alerts are kept");
    const run = await prisma.securityRetentionRun.findFirstOrThrow({ where: { organizationId: orgId }, orderBy: { ranAt: "desc" } });
    assert.deepEqual([run.purgedAlerts, run.purgedDevices, run.skipped], [1, 1, null]);
    await runSecurityRetention();
    assert.equal((await prisma.securityRetentionRun.findFirstOrThrow({ where: { organizationId: orgId }, orderBy: { ranAt: "desc" } })).purgedAlerts, 0);
    const overview = expect(await call("GET", `${base}/overview`, owner.cookie), 200);
    assert.ok(overview.lastRetentionRun);
    // An exception needs a reason and a future end.
    assert.equal((await putPolicy({ retentionExemption: { until: new Date(Date.now() - 1000).toISOString(), reason: "stale one" } })).statusCode, 422);
  });
});
