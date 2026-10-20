import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

// Organization onboarding: emailed invitations that create the account, member accounts created by an administrator,
// the per-organization storage limit and permanent deletion of content (category / subcategory / panel).
test("Organization onboarding integration", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5529?ignoreTLS=true";
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
  await new Promise<void>((resolve) => smtp.listen(5529, "127.0.0.1", resolve));
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

  const slug = `onb${prefix}`;
  const owner = await verifiedAccount("owner");
  const organizationId = expect(await call("POST", "/v1/organizations", owner.cookie, { name: "Onboarding Org", slug }), 201).id as string;

  await t.test("password and address formats", () => {
    assert.match(generatedPassword("shark"), /^SHARK-PASS-[A-Za-z0-9]{10}$/);
    assert.notEqual(generatedPassword("shark"), generatedPassword("shark"));
    assert.equal(localPartOf("Samuel Pérez"), "samuel");
    assert.equal(localPartOf("  "), "user");
  });

  await t.test("a new organization has a 5 GiB storage limit and members can read it", async () => {
    const summary = expect(await call("GET", `/v1/organizations/${organizationId}/storage`, owner.cookie), 200);
    assert.equal(summary.limitBytes, String(5 * 1024 ** 3));
    assert.equal(summary.usedBytes, "0");
  });

  await t.test("an emailed invitation creates the account in one step, without verification", async () => {
    const email = `${prefix}-newcomer@blackpolar.test`;
    expect(await call("POST", `/v1/organizations/${organizationId}/invitations`, owner.cookie, { email, role: "MEMBER" }), 201);
    const token = messages.at(-1)!.replace(/=\r?\n/g, "").replace(/=3D/gi, "=").match(/[?&]invitation=([a-f0-9]{64})/i)?.[1];
    assert.ok(token, "the invitation mail carries the link");
    const preview = expect(await call("POST", "/v1/invitations/validate", undefined, { token }), 200);
    assert.equal(preview.email, email);
    assert.equal(preview.accountExists, false);
    expect(await call("POST", "/v1/invitations/accept-new", undefined, { token, name: "New Comer", password: "short" }), 400);
    const joined = expect(await call("POST", "/v1/invitations/accept-new", undefined, { token, name: "New Comer", password: "Newcomer-password-42" }), 201);
    assert.equal(joined.email, email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    assert.equal(user.emailVerified, true);
    assert.ok(await prisma.membership.findUnique({ where: { organizationId_userId: { organizationId, userId: user.id } } }));
    expect(await signIn(email, "Newcomer-password-42"), 200);
    expect(await call("POST", "/v1/invitations/accept-new", undefined, { token, name: "Again", password: "Newcomer-password-42" }), 404);
  });

  await t.test("an invitation to an existing account asks to sign in and does not require a verified email", async () => {
    const existing = await verifiedAccount("existing");
    await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: false } });
    expect(await call("POST", `/v1/organizations/${organizationId}/invitations`, owner.cookie, { email: existing.email, role: "VIEWER" }), 201);
    const token = messages.at(-1)!.replace(/=\r?\n/g, "").replace(/=3D/gi, "=").match(/[?&]invitation=([a-f0-9]{64})/i)![1]!;
    const preview = expect(await call("POST", "/v1/invitations/validate", undefined, { token }), 200);
    assert.equal(preview.accountExists, true);
    expect(await call("POST", "/v1/invitations/accept-new", undefined, { token, name: "Existing", password: "Existing-password-42" }), 409);
  });

  await t.test("an administrator creates members: address name@org.bp, generated or typed password", async () => {
    const generated = expect(await call("POST", `/v1/organizations/${organizationId}/members/new`, owner.cookie, { name: "Samuel Pérez", role: "MEMBER" }), 201);
    assert.equal(generated.user.email, `samuel@${slug}.bp`);
    assert.match(generated.password, new RegExp(`^${slug.toUpperCase()}-PASS-[A-Za-z0-9]{10}$`));
    expect(await signIn(generated.user.email, generated.password), 200);
    const second = expect(await call("POST", `/v1/organizations/${organizationId}/members/new`, owner.cookie, { name: "Samuel Otro", role: "VIEWER" }), 201);
    assert.equal(second.user.email, `samuel2@${slug}.bp`);
    const typed = expect(await call("POST", `/v1/organizations/${organizationId}/members/new`, owner.cookie, { name: "Ana", localPart: "ana.lopez", password: "Ana-typed-password-9", role: "MEMBER" }), 201);
    assert.equal(typed.user.email, `ana.lopez@${slug}.bp`);
    assert.equal(typed.password, null);
    expect(await signIn(typed.user.email, "Ana-typed-password-9"), 200);
    expect(await call("POST", `/v1/organizations/${organizationId}/members/new`, owner.cookie, { name: "Ana 2", localPart: "ana.lopez", role: "MEMBER" }), 409);
    // Only the hash is stored and nothing audited carries the password.
    const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId, action: "membership.create_user" } }));
    assert.equal(audits.includes(generated.password), false);
    assert.equal(audits.includes("Ana-typed-password-9"), false);
    // A plain member cannot create accounts.
    const memberCookie = cookieOf(await signIn(typed.user.email, "Ana-typed-password-9"));
    expect(await call("POST", `/v1/organizations/${organizationId}/members/new`, memberCookie, { name: "Nope", role: "MEMBER" }), 403);
  });

  await t.test("organization-created accounts have no Personal Workspace (server-side) and are listed apart for operators", async () => {
    const made = expect(await call("POST", `/v1/organizations/${organizationId}/members/new`, owner.cookie, { name: "Managed Person", password: "Managed-password-42", role: "MEMBER" }), 201);
    const managedCookie = cookieOf(await signIn(made.user.email, "Managed-password-42"));
    assert.equal(expect(await call("GET", "/v1/me", managedCookie), 200).createdByOrganizationId, organizationId);
    assert.match(JSON.stringify(expect(await call("GET", "/v1/security/keys", managedCookie), 403)), /PERSONAL_WORKSPACE_UNAVAILABLE/);
    expect(await call("POST", "/v1/security/keys", managedCookie, { name: "Managed key", scopes: ["organizations:read"] }), 403);
    // An organization-created account stays in its organization: no other org can add it or accept it by key.
    const rival = await verifiedAccount("rival");
    const rivalOrg = expect(await call("POST", "/v1/organizations", rival.cookie, { name: "Rival Org", slug: `riv${prefix}` }), 201).id as string;
    assert.equal(expect(await call("GET", `/v1/organizations/${rivalOrg}/user-lookup?email=${encodeURIComponent(made.user.email)}`, rival.cookie), 200).exists, false);
    expect(await call("POST", `/v1/organizations/${rivalOrg}/members`, rival.cookie, { email: made.user.email }), 404);
    const key = expect(await call("POST", `/v1/organizations/${rivalOrg}/invitations`, rival.cookie, { kind: "CODE", role: "MEMBER" }), 201);
    assert.match(JSON.stringify(expect(await call("POST", "/v1/invitations/accept", managedCookie, { token: key.token }), 403)), /MANAGED_ACCOUNT_SINGLE_ORGANIZATION/);
    // Real-email accounts (self-registered, or created by accepting an emailed invitation) keep it.
    assert.equal(expect(await call("GET", "/v1/me", owner.cookie), 200).createdByOrganizationId, null);
    expect(await call("GET", "/v1/security/keys", owner.cookie), 200);
    const invited = await prisma.user.findUniqueOrThrow({ where: { email: `${prefix}-newcomer@blackpolar.test` } });
    assert.equal(invited.createdByOrganizationId, null);
    // Platform listing: hidden by default, shown with organizationManaged=true.
    await prisma.user.update({ where: { id: owner.id }, data: { role: "SUPERADMIN" } });
    try {
      const normal = expect(await call("GET", `/v1/platform/users?q=${encodeURIComponent(prefix)}&limit=100`, owner.cookie), 200);
      assert.equal(normal.items.some((item: { id: string }) => item.id === made.user.id), false);
      assert.equal(normal.items.some((item: { id: string }) => item.id === owner.id), true);
      const managed = expect(await call("GET", `/v1/platform/users?organizationManaged=true&q=${encodeURIComponent(prefix)}&limit=100`, owner.cookie), 200);
      assert.equal(managed.items.some((item: { id: string }) => item.id === made.user.id), true);
      assert.equal(managed.items.some((item: { id: string }) => item.id === owner.id), false);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { role: "USER" } });
    }
  });

  await t.test("categories, subcategories and panels can be permanently deleted", async () => {
    const category = expect(await call("POST", `/v1/organizations/${organizationId}/categories`, owner.cookie, { name: { es: "Borrable", en: "Deletable" }, slug: "borrable" }), 201);
    const subcategory = expect(await call("POST", `/v1/organizations/${organizationId}/categories/${category.id}/subcategories`, owner.cookie, { name: { es: "Sub", en: "Sub" }, slug: "sub" }), 201);
    const panel = expect(await call("POST", `/v1/organizations/${organizationId}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { es: "Panel", en: "Panel" }, slug: "panel" }), 201);
    const other = expect(await call("POST", `/v1/organizations/${organizationId}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { es: "Otro", en: "Other" }, slug: "otro" }), 201);
    expect(await call("DELETE", `/v1/organizations/${organizationId}/panels/${panel.id}`, owner.cookie), 200);
    assert.equal(await prisma.northPanel.count({ where: { id: panel.id } }), 0);
    expect(await call("DELETE", `/v1/organizations/${organizationId}/subcategories/${subcategory.id}`, owner.cookie), 200);
    assert.equal(await prisma.northPanel.count({ where: { id: other.id } }), 0);
    expect(await call("DELETE", `/v1/organizations/${organizationId}/categories/${category.id}`, owner.cookie), 200);
    assert.equal(await prisma.northCategory.count({ where: { id: category.id } }), 0);
    // System resources are protected.
    const home = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { homePanelId: true } });
    if (home.homePanelId) expect(await call("DELETE", `/v1/organizations/${organizationId}/panels/${home.homePanelId}`, owner.cookie), 403);
  });
});
