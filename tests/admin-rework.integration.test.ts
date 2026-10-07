import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

test("Admin rework integration", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5528?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";
  const KEY = "ab".repeat(32);
  process.env.AUID_ENCRYPTION_KEY = KEY;

  const messages: string[] = [];
  const smtp = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, callback) {
      let value = "";
      stream.on("data", (data) => { value += data; });
      stream.on("end", () => { messages.push(value); callback(); });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(5528, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { hashPassword } = await import("better-auth/crypto");
  const { encryptAuid, decryptAuid } = await import("../src/modules/identity/auid-crypto.js");
  const { resetActorRateLimits } = await import("../src/shared/actor-rate-limit.js");
  const { requireAnotherSuperadmin } = await import("../src/modules/identity/service.js");
  const app = await buildApp({ logger: process.env.TEST_LOG ? { level: "error" } : false });
  await app.ready();
  const promoted: string[] = [];
  t.after(async () => {
    if (promoted.length) await prisma.user.updateMany({ where: { id: { in: promoted } }, data: { role: "USER" } });
    await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve()));
  });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `127.0.20.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const expect = (response: Res, status: number) => {
    assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`);
    return response.json();
  };
  const cookieOf = (response: Res) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const signIn = (email: string, pass: string) =>
    app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.21.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000" }, payload: { email, password: pass } });
  const adminSignIn = (email: string, secret: string) =>
    app.inject({ method: "POST", url: "/v1/admin/sign-in", remoteAddress: `127.0.22.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000" }, payload: { email, secret } });

  let signupAddress = 10;
  async function account(label: string, role?: "ADMIN" | "SUPERADMIN") {
    const email = `${prefix}-${label}@blackpolar.test`;
    expect(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: `127.0.23.${signupAddress++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expect(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await signIn(email, password);
    expect(login, 200);
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    if (role) { await prisma.user.update({ where: { id: row.id }, data: { role } }); if (role === "SUPERADMIN") promoted.push(row.id); }
    return { id: row.id, email, cookie: cookieOf(login) };
  }
  const audits = (action: string, targetId?: string) => prisma.auditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) }, orderBy: { createdAt: "asc" } });
  const auidOf = () => `AUID-${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 24)}`;
  async function giveAuid(userId: string, auid: string, sealed = true) {
    const box = sealed ? encryptAuid(userId, auid) : null;
    await prisma.user.update({ where: { id: userId }, data: { adminSecretHash: await hashPassword(auid), adminSecretCiphertext: box?.ciphertext ?? null, adminSecretEncryptionVersion: box?.version ?? null } });
  }

  const superUser = await account("super", "SUPERADMIN");
  const adminUser = await account("admin", "ADMIN");

  // ------------------------------------------------------------------ AUID Reveal
  await t.test("Reveal: SUPERADMIN with the right password gets the AUID, never cached", async () => {
    resetActorRateLimits();
    const auid = auidOf();
    await giveAuid(adminUser.id, auid);
    const response = await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, superUser.cookie, { password });
    assert.equal(expect(response, 200).auid, auid);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["pragma"], "no-cache");
    const state = expect(await call("GET", `/v1/platform/users/${adminUser.id}/auid`, superUser.cookie), 200);
    assert.deepEqual([state.configured, state.revealable], [true, true]);
    assert.equal(JSON.stringify(state).includes(auid), false);
    const events = await audits("admin.auid.revealed", adminUser.id);
    assert.ok(events.length >= 1 && events.every((event) => event.actorId === superUser.id));
    assert.equal(JSON.stringify(events).includes(auid), false);
  });

  await t.test("Reveal: wrong password is denied, audited and consumes the per-actor rate limit", async () => {
    resetActorRateLimits();
    const auid = auidOf();
    await giveAuid(adminUser.id, auid);
    const before = (await audits("admin.auid.reveal_denied", adminUser.id)).length;
    for (let attempt = 0; attempt < 5; attempt++) {
      const denied = await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, superUser.cookie, { password: "wrong-password-123" });
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.body.includes(auid), false);
    }
    const events = (await audits("admin.auid.reveal_denied", adminUser.id)).slice(before);
    assert.equal(events.length, 5);
    assert.ok(events.every((event) => (event.metadata as { reason: string }).reason === "reauthentication_failed" && event.actorId === superUser.id));
    // Even the correct password is now throttled, from any address: the limit follows the actor.
    assert.equal((await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, superUser.cookie, { password })).statusCode, 429);
    resetActorRateLimits();
  });

  await t.test("Reveal: ADMIN and anonymous callers are refused", async () => {
    resetActorRateLimits();
    const denied = await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, adminUser.cookie, { password });
    assert.equal(denied.statusCode, 403);
    assert.ok((await audits("admin.auid.reveal_denied", adminUser.id)).some((event) => event.actorId === adminUser.id && (event.metadata as { reason: string }).reason === "forbidden"));
    assert.equal((await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, undefined, { password })).statusCode, 401);
    assert.equal((await call("POST", `/v1/platform/users/${adminUser.id}/auid/regenerate`, adminUser.cookie, { password })).statusCode, 403);
  });

  await t.test("Reveal: legacy AUID (hash only) is not revealable; missing key and tampering give a generic 503", async () => {
    resetActorRateLimits();
    await giveAuid(adminUser.id, auidOf(), false);
    expect(await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, superUser.cookie, { password }), 409);
    const state = expect(await call("GET", `/v1/platform/users/${adminUser.id}/auid`, superUser.cookie), 200);
    assert.deepEqual([state.configured, state.revealable], [true, false]);

    const auid = auidOf();
    await giveAuid(adminUser.id, auid);
    delete process.env.AUID_ENCRYPTION_KEY;
    const unavailable = await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, superUser.cookie, { password });
    process.env.AUID_ENCRYPTION_KEY = KEY;
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().error.code, "AUID_REVEAL_UNAVAILABLE");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: adminUser.id } });
    const parts = row.adminSecretCiphertext!.split(":");
    parts[2] = Buffer.from("tampered-bytes").toString("base64url");
    await prisma.user.update({ where: { id: adminUser.id }, data: { adminSecretCiphertext: parts.join(":") } });
    const corrupt = await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, superUser.cookie, { password });
    assert.equal(corrupt.statusCode, 503);
    assert.equal(corrupt.body, unavailable.body.replace(unavailable.json().error.requestId, corrupt.json().error.requestId), "no crypto details reach the client");
    const reasons = (await audits("admin.auid.reveal_denied", adminUser.id)).map((event) => (event.metadata as { reason: string }).reason);
    assert.ok(reasons.includes("key_unavailable"));
    assert.ok(reasons.includes("ciphertext_integrity:authentication_failed"));
  });

  // ------------------------------------------------------------------ AUID Regenerate
  await t.test("Regenerate: old AUID stops, new one works and can be revealed; hash and ciphertext stay in sync", async () => {
    resetActorRateLimits();
    const old = auidOf();
    await giveAuid(adminUser.id, old);
    expect(await adminSignIn(adminUser.email, old), 200);
    const { auid } = expect(await call("POST", `/v1/platform/users/${adminUser.id}/auid/regenerate`, superUser.cookie, { password }), 200);
    assert.match(auid, /^AUID-[A-Z2-9]{24}$/);
    assert.equal((await adminSignIn(adminUser.email, old)).statusCode, 401);
    expect(await adminSignIn(adminUser.email, auid), 200);
    assert.equal(expect(await call("POST", `/v1/platform/users/${adminUser.id}/auid/reveal`, superUser.cookie, { password }), 200).auid, auid);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: adminUser.id } });
    assert.equal(decryptAuid(adminUser.id, row.adminSecretCiphertext!, row.adminSecretEncryptionVersion!), auid);
    const events = await audits("admin.auid.regenerated", adminUser.id);
    assert.equal(JSON.stringify(events).includes(auid), false);
    assert.equal(JSON.stringify(events).includes(row.adminSecretCiphertext!), false);
  });

  await t.test("Regenerate fails closed (503) without the encryption key and leaves the old AUID intact", async () => {
    resetActorRateLimits();
    const old = auidOf();
    await giveAuid(adminUser.id, old);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: adminUser.id } });
    delete process.env.AUID_ENCRYPTION_KEY;
    const response = await call("POST", `/v1/platform/users/${adminUser.id}/auid/regenerate`, superUser.cookie, { password });
    process.env.AUID_ENCRYPTION_KEY = KEY;
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "AUID_ENCRYPTION_UNAVAILABLE");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: adminUser.id } });
    assert.equal(after.adminSecretHash, before.adminSecretHash);
    assert.equal(after.adminSecretCiphertext, before.adminSecretCiphertext);
    expect(await adminSignIn(adminUser.email, old), 200);
  });

  await t.test("Regenerate: wrong password changes nothing and is audited", async () => {
    resetActorRateLimits();
    const old = auidOf();
    await giveAuid(adminUser.id, old);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: adminUser.id } });
    assert.equal((await call("POST", `/v1/platform/users/${adminUser.id}/auid/regenerate`, superUser.cookie, { password: "nope-nope-nope-1" })).statusCode, 401);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: adminUser.id } })).adminSecretHash, before.adminSecretHash);
    assert.ok((await audits("admin.auid.regenerate_denied", adminUser.id)).some((event) => (event.metadata as { reason: string }).reason === "reauthentication_failed"));
  });

  await t.test("bootstrapOperator seals the AUID when the key exists and stays legacy (never blocked) without it", async () => {
    const { bootstrapOperator } = await import("../src/modules/identity/bootstrap.js");
    // bootstrap may only target an existing SUPERADMIN while one exists; use a dedicated one so superUser keeps its sessions/password
    const boot = await account("boot", "SUPERADMIN");
    const secret = `Bootstrap-secret-${randomUUID()}`;
    await bootstrapOperator(boot.email, secret, "Temporary-password-123!");
    let row = await prisma.user.findUniqueOrThrow({ where: { id: boot.id } });
    assert.ok(row.adminSecretCiphertext && row.adminSecretEncryptionVersion === 1);
    assert.equal(decryptAuid(boot.id, row.adminSecretCiphertext!, 1), secret);
    delete process.env.AUID_ENCRYPTION_KEY;
    await bootstrapOperator(boot.email, `${secret}-2`, "Temporary-password-123!");
    process.env.AUID_ENCRYPTION_KEY = KEY;
    row = await prisma.user.findUniqueOrThrow({ where: { id: boot.id } });
    assert.equal(row.adminSecretCiphertext, null, "no stale recoverable copy of the previous secret");
    assert.ok(row.adminSecretHash);
  });

  // ------------------------------------------------------------------ Invitation keys
  const owner = await account("owner");
  const org = expect(await call("POST", "/v1/organizations", owner.cookie, { name: `Rework ${prefix}`, slug: `rework-${prefix}` }), 201);
  const createKey = async (payload: object = {}) => expect(await call("POST", `/v1/organizations/${org.id}/invitations`, owner.cookie, { kind: "CODE", role: "MEMBER", ...payload }), 201);
  const validate = (token: string) => call("POST", "/v1/invitations/validate", undefined, { token });
  const accept = (cookie: string, token: string) => call("POST", "/v1/invitations/accept", cookie, { token });
  const useCount = async (id: string) => (await prisma.invitation.findUniqueOrThrow({ where: { id } })).useCount;

  await t.test("organization key: create -> validate -> join -> useCount", async () => {
    const key = await createKey({ maxUses: 1 });
    assert.match(key.token, /^[A-Z0-9]{1,12}-KEY-[A-Z2-9]{12}$/);
    assert.equal(key.keyHint, key.token.slice(-4));
    const stored = await prisma.invitation.findUniqueOrThrow({ where: { id: key.id } });
    assert.notEqual(stored.tokenHash, key.token, "only a hash is stored");
    assert.equal(stored.createdByUserId, owner.id);
    const preview = expect(await validate(key.token), 200);
    assert.equal(preview.organization.slug, `rework-${prefix}`);
    assert.equal(expect(await validate(key.token.toLowerCase()), 200).organization.slug, `rework-${prefix}`);
    const joiner = await account("joiner");
    expect(await accept(joiner.cookie, key.token), 200);
    assert.equal(await useCount(key.id), 1);
    assert.ok(await prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: org.id, userId: joiner.id } } }));
  });

  await t.test("multi-use key counts 0 -> 3 and rejects the 4th", async () => {
    const key = await createKey({ maxUses: 3 });
    assert.equal(await useCount(key.id), 0);
    for (let step = 1; step <= 3; step++) {
      const person = await account(`multi${step}`);
      expect(await accept(person.cookie, key.token), 200);
      assert.equal(await useCount(key.id), step);
    }
    const fourth = await account("multi4");
    assert.equal((await accept(fourth.cookie, key.token)).statusCode, 404);
    assert.equal(await useCount(key.id), 3);
    assert.equal((await validate(key.token)).statusCode, 404, "an exhausted key no longer validates");
    assert.equal(await prisma.membership.count({ where: { organizationId: org.id, userId: fourth.id } }), 0);
  });

  await t.test("concurrent accepts of a single-use key: exactly one wins", async () => {
    const key = await createKey({ maxUses: 1 });
    const [a, b] = [await account("race-a"), await account("race-b")];
    const results = await Promise.all([accept(a.cookie, key.token), accept(b.cookie, key.token)]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 404]);
    assert.equal(await useCount(key.id), 1);
    assert.equal(await prisma.membership.count({ where: { organizationId: org.id, userId: { in: [a.id, b.id] } } }), 1);
  });

  await t.test("expired and revoked keys are rejected", async () => {
    const expired = await createKey({ maxUses: 5 });
    await prisma.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await validate(expired.token)).statusCode, 404);
    const revoked = await createKey({ maxUses: 5 });
    expect(await validate(revoked.token), 200);
    assert.ok([200, 204].includes((await call("DELETE", `/v1/organizations/${org.id}/invitations/${revoked.id}`, owner.cookie)).statusCode));
    assert.equal((await validate(revoked.token)).statusCode, 404);
    const late = await account("late");
    assert.equal((await accept(late.cookie, revoked.token)).statusCode, 404);
    assert.equal((await validate("NOPE-KEY-AAAAAAAAAAAA")).statusCode, 404);
  });

  // ------------------------------------------------------------------ Organization identity
  await t.test("organization icon and description are validated server-side", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const updated = expect(await call("PATCH", `/v1/organizations/${org.id}`, owner.cookie, { iconData: png, description: "  About us  " }), 200);
    assert.equal(updated.iconData, png);
    assert.equal(updated.description, "About us");
    assert.equal((await call("PATCH", `/v1/organizations/${org.id}`, owner.cookie, { iconData: "data:image/png;base64,AAAA" })).statusCode, 400);
    assert.equal((await call("PATCH", `/v1/organizations/${org.id}`, owner.cookie, { description: "x".repeat(501) })).statusCode, 400);
    expect(await call("PATCH", `/v1/organizations/${org.id}`, owner.cookie, { iconData: null }), 200);
  });

  // ------------------------------------------------------------------ Platform inspection
  const inspectionHeaders = (sessionId: string) => ({ "x-platform-inspect": org.id, "x-platform-inspection-session": sessionId });
  await t.test("inspection session: no membership, audited start/end, sensitive reads only, mutations blocked", async () => {
    const started = expect(await call("POST", `/v1/platform/organizations/${org.id}/inspection`, superUser.cookie), 200);
    const sessionId = started.inspectionSessionId as string;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    const headers = inspectionHeaders(sessionId);
    const noise = (await prisma.auditLog.count({ where: { actorId: superUser.id, organizationId: org.id } }));

    for (const path of ["navigation", "north/management-tree", ""]) {
      const response = await call("GET", `/v1/organizations/${org.id}${path ? `/${path}` : ""}`, superUser.cookie, undefined, headers);
      assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
    }
    assert.equal(await prisma.auditLog.count({ where: { actorId: superUser.id, organizationId: org.id } }), noise, "ordinary reads add no audit noise");

    const reads: Record<string, string> = {
      members: "platform.inspection.users.viewed",
      groups: "platform.inspection.permissions.viewed",
      audit: "platform.inspection.audit.viewed",
      invitations: "platform.inspection.invitations.viewed",
      billing: "platform.inspection.billing.viewed",
    };
    for (const [path, action] of Object.entries(reads)) {
      const response = await call("GET", `/v1/organizations/${org.id}/${path}`, superUser.cookie, undefined, headers);
      assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
      const events = (await audits(action)).filter((event) => event.actorId === superUser.id && event.organizationId === org.id);
      assert.ok(events.length >= 1, action);
      assert.equal((events.at(-1)!.metadata as { inspectionSessionId: string }).inspectionSessionId, sessionId);
    }

    // read-only: every write is 403 and audited without bodies
    const attempts: Array<[Method, string, unknown]> = [
      ["POST", `/v1/organizations/${org.id}/invitations`, { kind: "CODE", role: "MEMBER" }],
      ["PUT", `/v1/organizations/${org.id}/home-panel`, { panelId: "p1" }],
      ["PATCH", `/v1/organizations/${org.id}`, { name: "do-not-log-this" }],
      ["DELETE", `/v1/organizations/${org.id}/invitations/some-id`, undefined],
      ["POST", `/v1/organizations/${org.id}/invitations/some-id/replace`, undefined],
    ];
    for (const [method, url, payload] of attempts) {
      const response = await call(method, url, superUser.cookie, payload, headers);
      assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`);
      assert.equal(response.json().error.code, "INSPECTION_READ_ONLY");
    }
    const blocked = (await audits("platform.inspection.mutation_blocked")).filter((event) => event.actorId === superUser.id && event.organizationId === org.id);
    assert.deepEqual([...new Set(blocked.map((event) => (event.metadata as { method: string }).method))].sort(), ["DELETE", "PATCH", "POST", "PUT"]);
    for (const event of blocked) {
      const meta = event.metadata as { resource: string; inspectionSessionId: string };
      assert.equal(meta.inspectionSessionId, sessionId);
      assert.match(meta.resource, /:organizationId/, "route pattern, not the concrete path");
    }
    assert.equal(JSON.stringify(blocked).includes("do-not-log-this"), false, "no request bodies in audit");
    assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).name, `Rework ${prefix}`);

    // header is operator-only and targets exactly one organization
    assert.equal((await call("GET", `/v1/organizations/${org.id}`, adminUser.cookie, undefined, headers)).statusCode, 200);
    assert.equal((await call("GET", `/v1/organizations/${org.id}`, owner.cookie)).statusCode, 200);
    const plain = await account("plain");
    assert.equal((await call("GET", `/v1/organizations/${org.id}`, plain.cookie, undefined, headers)).statusCode, 403);
    assert.equal((await call("GET", `/v1/organizations/${org.id}`, plain.cookie)).statusCode, 404);
    const other = expect(await call("POST", "/v1/organizations", owner.cookie, { name: `Other ${prefix}`, slug: `other-${prefix}` }), 201);
    assert.equal((await call("GET", `/v1/organizations/${other.id}`, superUser.cookie, undefined, headers)).statusCode, 404, "inspection never leaks into another tenant");

    expect(await call("DELETE", `/v1/platform/organizations/${org.id}/inspection`, superUser.cookie, undefined, { "x-platform-inspection-session": sessionId }), 200);
    assert.equal(await prisma.membership.count({ where: { organizationId: org.id, userId: { in: [superUser.id, adminUser.id] } } }), 0, "no membership is ever created");
    const started1 = (await audits("platform.inspection.started")).filter((event) => event.organizationId === org.id);
    const ended = (await audits("platform.inspection.ended")).filter((event) => event.organizationId === org.id);
    assert.equal((started1.at(-1)!.metadata as { inspectionSessionId: string }).inspectionSessionId, sessionId);
    assert.equal((ended.at(-1)!.metadata as { inspectionSessionId: string }).inspectionSessionId, sessionId);
    // after the session the header alone still cannot write
    assert.equal((await call("GET", `/v1/organizations/${org.id}`, plain.cookie)).statusCode, 404);
  });

  await t.test("invitations.read vs invitations.manage", async () => {
    const { effectivePermissions } = await import("../src/modules/authorization/policy.js");
    const { inspectionPermissions } = await import("../src/modules/authorization/inspection.js");
    assert.ok(inspectionPermissions.includes("invitations.read"));
    assert.equal(inspectionPermissions.includes("invitations.manage" as never), false);
    assert.ok(effectivePermissions("OWNER").includes("invitations.read"));
    assert.equal(effectivePermissions("MEMBER").includes("invitations.read"), false);
    const member = await account("member-view");
    expect(await accept(member.cookie, (await createKey({ maxUses: 1 })).token), 200);
    assert.equal((await call("GET", `/v1/organizations/${org.id}/invitations`, member.cookie)).statusCode, 403);
  });

  // ------------------------------------------------------------------ Last SUPERADMIN / users list
  await t.test("SUPERADMIN protections: suspend, delete and demote never leave NORTH without one", async () => {
    const second = await account("super2", "SUPERADMIN");
    // suspension of any SUPERADMIN is blocked outright
    assert.equal((await call("PATCH", `/v1/platform/users/${second.id}/status`, superUser.cookie, { status: "SUSPENDED" })).json().error.code, "SUPERADMIN_PROTECTED");
    assert.equal((await call("PATCH", `/v1/platform/users/${superUser.id}/status`, superUser.cookie, { status: "SUSPENDED" })).statusCode, 409);
    // acting on yourself is blocked
    assert.equal((await call("DELETE", `/v1/users/${superUser.id}`, superUser.cookie)).statusCode, 409);
    assert.equal((await call("PATCH", `/v1/users/${superUser.id}`, superUser.cookie, { role: "USER" })).statusCode, 409);
    // ADMIN cannot touch SUPERADMIN
    assert.equal((await call("DELETE", `/v1/users/${superUser.id}`, adminUser.cookie)).statusCode, 403);
    assert.equal((await call("PATCH", `/v1/users/${superUser.id}`, adminUser.cookie, { role: "USER" })).statusCode, 403);
    // the explicit guard: demoting/deleting is refused when the target is the only active SUPERADMIN
    await prisma.user.updateMany({ where: { role: "SUPERADMIN", id: { not: superUser.id } }, data: { role: "USER" } });
    await assert.rejects(prisma.$transaction((tx) => requireAnotherSuperadmin(tx, superUser.id)), /last SUPERADMIN/i);
    await prisma.user.update({ where: { id: second.id }, data: { role: "SUPERADMIN" } });
    await prisma.$transaction((tx) => requireAnotherSuperadmin(tx, superUser.id));
    // a SUPERADMIN may demote another one while still being present themselves
    expect(await call("PATCH", `/v1/users/${second.id}`, superUser.cookie, { role: "USER" }), 200);
    assert.equal(await prisma.user.count({ where: { id: superUser.id, role: "SUPERADMIN" } }), 1);
  });

  await t.test("platform users list carries organizationCount from a single query", async () => {
    const page = expect(await call("GET", `/v1/platform/users?q=${prefix}-owner&limit=5`, superUser.cookie), 200);
    const row = page.items.find((item: { email: string }) => item.email === owner.email);
    assert.ok(row && row.organizationCount >= 2);
    assert.equal(JSON.stringify(page).includes("adminSecret"), false);
  });
});
