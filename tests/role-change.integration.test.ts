import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/**
 * Role changes and revocation take effect on the very next request of an already-open session (no cache, no re-login):
 * Admin -> Viewer, Viewer -> Admin, removal, concurrent sessions of one user, and cross-tenant access by resource id.
 */
test("role change and revocation are immediate; tenants stay isolated", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5542?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5542, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let n = 0;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie?: string, payload?: object) =>
    app.inject({ method, url, remoteAddress: `127.0.${110 + Math.floor(n / 250)}.${(n++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
  const status = async (p: ReturnType<typeof call>, expected: number) => { const r = await p; assert.equal(r.statusCode, expected, `${r.statusCode}: ${r.body}`); return r.json(); };
  const signIn = async (email: string) => {
    const r = await call("POST", "/v1/auth/sign-in/email", undefined, { email, password });
    assert.equal(r.statusCode, 200, r.body);
    return r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  };
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    await status(call("POST", "/v1/auth/sign-up/email", undefined, { email, password, name: label }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    await status(call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { id: user.id, email, cookie: await signIn(email) };
  }

  const owner = await account("owner");
  const member = await account("member");
  const stranger = await account("stranger");
  const orgA = (await status(call("POST", "/v1/organizations", owner.cookie, { name: `A ${prefix}` }), 201)).id as string;
  const orgB = (await status(call("POST", "/v1/organizations", stranger.cookie, { name: `B ${prefix}` }), 201)).id as string;
  await prisma.membership.create({ data: { organizationId: orgA, userId: member.id, role: "ADMIN" } });
  const secondSession = await signIn(member.email);
  const perms = async (cookie: string, org = orgA) => (await status(call("GET", `/v1/organizations/${org}/permissions`, cookie), 200)) as { role: string; permissions: string[] };

  await t.test("Admin -> Viewer applies to the open session, a concurrent session and a fresh reload", async () => {
    assert.equal((await perms(member.cookie)).role, "ADMIN");
    assert.ok((await perms(member.cookie)).permissions.includes("members.manage"));
    await status(call("PATCH", `/v1/organizations/${orgA}/members/${member.id}`, owner.cookie, { role: "VIEWER" }), 200);
    for (const cookie of [member.cookie, secondSession, await signIn(member.email)]) {
      const p = await perms(cookie);
      assert.equal(p.role, "VIEWER");
      assert.ok(!p.permissions.includes("members.manage"));
      await status(call("PATCH", `/v1/organizations/${orgA}`, cookie, { name: "Hijack" }), 403);
    }
  });

  await t.test("Viewer -> Admin applies immediately", async () => {
    await status(call("PATCH", `/v1/organizations/${orgA}/members/${member.id}`, owner.cookie, { role: "ADMIN" }), 200);
    assert.equal((await perms(secondSession)).role, "ADMIN");
    await status(call("PATCH", `/v1/organizations/${orgA}`, secondSession, { name: `A ${prefix} renamed` }), 200);
  });

  await t.test("revocation: removed member loses the organization everywhere, with no leak", async () => {
    const removed = await call("DELETE", `/v1/organizations/${orgA}/members/${member.id}`, owner.cookie);
    assert.ok([200, 204].includes(removed.statusCode), removed.body);
    for (const cookie of [member.cookie, secondSession]) {
      await status(call("GET", `/v1/organizations/${orgA}/permissions`, cookie), 404);
      await status(call("GET", `/v1/organizations/${orgA}/members`, cookie), 404);
      const list = (await status(call("GET", "/v1/organizations", cookie), 200)) as Array<{ id: string }>;
      assert.ok(!list.some((o) => o.id === orgA));
    }
  });

  await t.test("cross-tenant: another tenant's owner cannot reach this organization or touch its member by id", async () => {
    await status(call("GET", `/v1/organizations/${orgA}/permissions`, stranger.cookie), 404);
    await status(call("PATCH", `/v1/organizations/${orgA}/members/${owner.id}`, stranger.cookie, { role: "VIEWER" }), 404);
    await status(call("PATCH", `/v1/organizations/${orgB}/members/${owner.id}`, stranger.cookie, { role: "VIEWER" }), 404);
    assert.equal((await prisma.membership.findFirstOrThrow({ where: { organizationId: orgA, userId: owner.id } })).role, "OWNER");
  });
});
