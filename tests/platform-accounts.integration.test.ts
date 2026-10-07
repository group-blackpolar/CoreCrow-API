import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

test("Platform accounts integration", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5527?ignoreTLS=true";
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
  await new Promise<void>((resolve) => smtp.listen(5527, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.8.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const expect = (response: Awaited<ReturnType<typeof call>>, status: number) => {
    assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`);
    return response.json();
  };
  const cookieOf = (response: Awaited<ReturnType<typeof call>>) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const signIn = (email: string, pass: string) =>
    app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.9.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000" }, payload: { email, password: pass } });

  let signupAddress = 10;
  async function signup(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    const remoteAddress = `127.0.7.${signupAddress++}`;
    expect(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    return { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, email };
  }
  async function verifiedLogin(account: { id: string; email: string }) {
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expect(await call("POST", "/v1/identity/verification/confirm", undefined, { email: account.email, code }), 200);
    const login = await signIn(account.email, password);
    expect(login, 200);
    return cookieOf(login);
  }

  const superUser = await signup("super");
  const superCookie = await verifiedLogin(superUser);
  await prisma.user.update({ where: { id: superUser.id }, data: { role: "SUPERADMIN" } });
  const plainUser = await signup("plain");
  const plainCookie = await verifiedLogin(plainUser);
  const adminUser = await signup("operator");
  const adminCookie = await verifiedLogin(adminUser);
  await prisma.user.update({ where: { id: adminUser.id }, data: { role: "ADMIN" } });

  const login = `soporte.${prefix}@blackpolar.local`;
  const assignedPassword = "Asignada-por-superadmin-42";

  await t.test("superadmin creates an admin with a chosen login and password; no verification is needed", async () => {
    const mailsBefore = messages.length;
    const created = expect(await call("POST", "/v1/platform/users", superCookie, { name: "Soporte", email: login, password: assignedPassword }), 201);
    assert.equal(created.role, "ADMIN");
    assert.equal(created.emailVerified, true);
    assert.equal(created.passwordChangeRequired, true, "forced change on first sign-in is the default");
    assert.equal("password" in created, false);
    assert.equal(messages.length, mailsBefore, "no verification or credential email is sent");
    // The account signs in straight away (email-shaped identifier, not necessarily a real mailbox).
    const signedIn = await signIn(login, assignedPassword);
    expect(signedIn, 200);
    assert.equal(expect(await call("GET", "/v1/me", cookieOf(signedIn)), 200).role, "ADMIN");
    assert.equal((await signIn(login, "otra-contrasena-incorrecta-1")).statusCode >= 400, true);
  });

  await t.test("password change can be waived, roles are limited, and the login is unique", async () => {
    const other = expect(await call("POST", "/v1/platform/users", superCookie, { name: "Servicio", email: `servicio.${prefix}@blackpolar.local`, password: assignedPassword, role: "DEVELOPER", passwordChangeRequired: false }), 201);
    assert.equal(other.passwordChangeRequired, false);
    assert.equal(other.role, "DEVELOPER");
    expect(await call("POST", "/v1/platform/users", superCookie, { name: "Duplicado", email: login.toUpperCase(), password: assignedPassword }), 409);
    expect(await call("POST", "/v1/platform/users", superCookie, { name: "Root", email: `root.${prefix}@blackpolar.local`, password: assignedPassword, role: "SUPERADMIN" }), 400);
    expect(await call("POST", "/v1/platform/users", superCookie, { name: "Corta", email: `corta.${prefix}@blackpolar.local`, password: "short" }), 400);
    expect(await call("POST", "/v1/platform/users", superCookie, { name: "Mal", email: "not-an-email", password: assignedPassword }), 400);
  });

  await t.test("only a superadmin may create accounts (default deny)", async () => {
    const body = { name: "Intruso", email: `intruso.${prefix}@blackpolar.local`, password: assignedPassword };
    expect(await call("POST", "/v1/platform/users", undefined, body), 401);
    expect(await call("POST", "/v1/platform/users", plainCookie, body), 403);
    expect(await call("POST", "/v1/platform/users", adminCookie, body), 403);
    assert.equal(await prisma.user.findUnique({ where: { email: body.email } }), null);
  });

  await t.test("superadmin verifies an unverified account, which can then sign in; others cannot", async () => {
    const pending = await signup("pending"); // signed up, code never entered
    assert.equal((await signIn(pending.email, password)).statusCode >= 400, true, "unverified accounts cannot sign in");
    expect(await call("POST", `/v1/platform/users/${pending.id}/verify-email`, adminCookie), 403);
    expect(await call("POST", `/v1/platform/users/${pending.id}/verify-email`, plainCookie), 403);
    const verified = expect(await call("POST", `/v1/platform/users/${pending.id}/verify-email`, superCookie), 200);
    assert.equal(verified.emailVerified, true);
    expect(await call("POST", `/v1/platform/users/${pending.id}/verify-email`, superCookie), 200); // idempotent
    expect(await signIn(pending.email, password), 200);
    expect(await call("POST", `/v1/platform/users/${randomUUID()}/verify-email`, superCookie), 404);
    assert.equal(await prisma.emailVerificationChallenge.count({ where: { userId: pending.id } }), 0, "pending codes are cleared");
  });

  await t.test("everything is audited and no secret reaches the audit log", async () => {
    const created = await prisma.user.findUniqueOrThrow({ where: { email: login } });
    const events = await prisma.auditLog.findMany({ where: { targetId: created.id }, orderBy: { createdAt: "asc" } });
    const actions = events.map((event) => event.action);
    assert.ok(actions.includes("platform.user.create"));
    assert.ok(actions.includes("identity.credential.assigned"));
    assert.ok(events.every((event) => event.actorId === superUser.id));
    assert.equal(JSON.stringify(events).includes(assignedPassword), false, "the password never appears in audit data");
    const stored = await prisma.account.findFirstOrThrow({ where: { userId: created.id, providerId: "credential" } });
    assert.notEqual(stored.password, assignedPassword, "only a hash is stored");
    assert.ok((await prisma.auditLog.count({ where: { action: "platform.user.verify_email", actorId: superUser.id } })) >= 1);
  });
});
