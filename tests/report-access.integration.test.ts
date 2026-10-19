import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

test("report access summary: allowed / restricted / not configured, tenant isolation, no leakage", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5537?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5537, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.100.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
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
  const member = await account("member");
  const outsider = await account("outsider");
  const org = expectStatus(await call("POST", "/v1/organizations", owner.cookie, { name: `Reports ${prefix}` }), 201).id as string;
  await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` });
  const base = `/v1/organizations/${org}`;
  expectStatus(await call("POST", "/v1/invitations/accept", member.cookie, { token: expectStatus(await call("POST", `${base}/invitations`, owner.cookie, { kind: "CODE", role: "MEMBER" }), 201).token }), 200);

  // Four report categories: open to members, admins only, configured but unpublished, and one never created.
  const report = async (slug: string, audience: object | null, publish: boolean) => {
    const category = expectStatus(await call("POST", `${base}/categories`, owner.cookie, { name: { en: slug }, slug }), 201);
    const subcategory = expectStatus(await call("POST", `${base}/categories/${category.id}/subcategories`, owner.cookie, { name: { en: "Main" }, slug: "main" }), 201);
    const panel = expectStatus(await call("POST", `${base}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { en: "Dashboard" }, slug: "dashboard" }), 201);
    if (audience) expectStatus(await call("PUT", `${base}/panels/${panel.id}/audience`, owner.cookie, audience), 200);
    if (publish) await prisma.northPanel.update({ where: { id: panel.id }, data: { status: "PUBLISHED" } });
    return { category, subcategory, panel };
  };
  const open = await report("master-house", null, true);
  await report("local-import", { type: "ROLES", roles: ["OWNER", "ADMIN"] }, true);
  await report("free-zone-import", null, false);

  const access = (cookie: string, organization = org, categories = "master-house,local-import,free-zone-import,maritime-export") => call("GET", `/v1/organizations/${organization}/report-access?categories=${categories}`, cookie);
  const states = (rows: Array<{ slug: string; state: string }>) => Object.fromEntries(rows.map((row) => [row.slug, row.state]));

  const asOwner = expectStatus(await access(owner.cookie), 200);
  assert.deepEqual(states(asOwner), { "master-house": "ALLOWED", "local-import": "ALLOWED", "free-zone-import": "NOT_CONFIGURED", "maritime-export": "NOT_CONFIGURED" });
  assert.deepEqual(asOwner[0].target, { categoryId: open.category.id, categorySlug: "master-house", subcategoryId: open.subcategory.id, subcategorySlug: "main", panelSlug: "dashboard" });

  // A plain member sees the same four slugs, but the admin-only report is RESTRICTED and carries no target or names.
  const asMember = expectStatus(await access(member.cookie), 200);
  assert.deepEqual(states(asMember), { "master-house": "ALLOWED", "local-import": "RESTRICTED", "free-zone-import": "NOT_CONFIGURED", "maritime-export": "NOT_CONFIGURED" });
  assert.deepEqual(Object.keys(asMember.find((row: { slug: string }) => row.slug === "local-import")).sort(), ["slug", "state", "target"]);
  assert.equal(asMember.find((row: { slug: string }) => row.slug === "local-import").target, null);

  // The summary agrees with what the real open path allows: a RESTRICTED report cannot be resolved by URL.
  const slugOf = expectStatus(await call("GET", `/v1/organizations/${org}`, owner.cookie), 200).slug as string;
  assert.equal((await call("GET", `/v1/content/resolve?organizationSlug=${slugOf}&categorySlug=local-import&subcategorySlug=main&panelSlug=dashboard`, member.cookie)).statusCode >= 400, true);

  // Tenant isolation, authentication and input validation.
  assert.equal((await access(outsider.cookie)).statusCode, 404);
  assert.equal((await call("GET", `${base}/report-access?categories=master-house`)).statusCode, 401);
  assert.equal((await access(owner.cookie, org, "Bad Slug")).statusCode, 400);
  assert.equal((await access(owner.cookie, org, "")).statusCode, 400);
  assert.deepEqual(states(expectStatus(await access(owner.cookie, org, "master-house,master-house"), 200)), { "master-house": "ALLOWED" });

  // The system Home exists for every organization and is not hidden.
  const home = await prisma.northCategory.findFirstOrThrow({ where: { organizationId: org, slug: "home", resourceKind: "SYSTEM" } });
  assert.equal(home.navigationHidden, false);
});
