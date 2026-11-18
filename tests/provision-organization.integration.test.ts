import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/** Declarative organization provisioning (Stress Test definition) through the normal API: idempotent, restricted, isolated. */
test("provision-organization: Stress Test is created once, idempotently, restricted to its owner, without standard home", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5545?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5545, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });
  // @ts-expect-error plain ESM scripts without type declarations
  const { reconcileOrganization } = await import("../scripts/lib/provision-organization-core.mjs");
  // @ts-expect-error plain ESM scripts without type declarations
  const definition = (await import("../scripts/organizations/stress-test.mjs")).default;

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let n = 0;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `127.0.${140 + Math.floor(n / 250)}.${(n++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...headers, ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const status = (response: Res, expected: number) => { assert.equal(response.statusCode, expected, `${response.statusCode}: ${response.body}`); return response.json(); };
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    status(await call("POST", "/v1/auth/sign-up/email", undefined, { email, password, name: label }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    status(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await call("POST", "/v1/auth/sign-in/email", undefined, { email, password });
    status(login, 200);
    return { cookie: login.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ") };
  }

  const owner = await account("owner");
  const stranger = await account("stranger");
  // The same contract the CLI uses: an HTTP call as the acting account.
  const as = (cookie: string) => async (method: Method, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await call(method, `/v1${path}`, cookie, body, headers);
    if (response.statusCode >= 400) throw Object.assign(new Error(`${method} ${path} -> ${response.statusCode} ${response.body}`), { status: response.statusCode });
    return { json: response.body ? response.json() : null, etag: (response.headers.etag as string | undefined) ?? null };
  };
  // Test-local identity so parallel runs on a used database never collide with a previous Stress Test.
  const slug = `stress-test-${prefix}`;
  const def = { ...definition, organization: { ...definition.organization, slug } };

  let organizationId = "";
  await t.test("first run creates the organization, localized categories and no landing page", async () => {
    const first = await reconcileOrganization(as(owner.cookie), def);
    organizationId = first.organizationId;
    assert.equal(first.organizationCreated, true);
    assert.equal(first.categoriesCreated, definition.categories.length);
    assert.equal(first.panelsSeeded, definition.categories.reduce((sum: number, c: { subcategories: unknown[] }) => sum + c.subcategories.length, 0));
    const organization = status(await call("GET", `/v1/organizations/${organizationId}`, owner.cookie), 200);
    assert.deepEqual([organization.name, organization.description], ["Stress Test", "Pruebas de Estrés"]);
    const navigation = status(await call("GET", `/v1/organizations/${organizationId}/navigation`, owner.cookie), 200) as Array<{ slug: string; name: Record<string, string>; subcategories: unknown[] }>;
    assert.deepEqual(navigation.map((c) => c.slug), [...definition.categories.map((c: { slug: string }) => c.slug), "admin"], "declared order, then the organization Administration; the system Home is hidden");
    assert.deepEqual(navigation[0]!.name, { es: "Evaluaciones", en: "Evaluations" });
    assert.equal(navigation[0]!.subcategories.length, 5);
    // A subcategory can host a registered component: the exams entry opens the evaluations workspace, configured by data.
    const exams = status(await call("GET", `/v1/content/resolve?organizationSlug=${slug}&categorySlug=evaluations&subcategorySlug=exams&panelSlug=overview`, owner.cookie), 200);
    const hosted = exams.revision.document.sections[0].components[0];
    assert.deepEqual([hosted.type, hosted.props.kind, hosted.props.views], ["evaluation_workspace", "EXAM", ["builder", "player", "results"]]);
    const landing = status(await call("GET", `/v1/organizations/${organizationId}/landing`, owner.cookie), 200);
    assert.equal(landing.mode, "NONE");
    assert.equal(status(await call("GET", `/v1/organizations/${organizationId}/landing/resolve`, owner.cookie), 200).target, null);
  });

  await t.test("second run changes nothing and creates no duplicates", async () => {
    const again = await reconcileOrganization(as(owner.cookie), def);
    assert.deepEqual({ ...again, organizationId: undefined }, { organizationId: undefined, organizationCreated: false, organizationUpdated: false, categoriesCreated: 0, categoriesUpdated: 0, subcategoriesCreated: 0, subcategoriesUpdated: 0, panelsSeeded: 0, landingUpdated: false });
    assert.equal(await prisma.organization.count({ where: { slug } }), 1);
    assert.equal(await prisma.northCategory.count({ where: { organizationId, resourceKind: "CONTENT" } }), definition.categories.length);
  });

  await t.test("categories are ordinary administration: a rename is reconciled back, a manual extra category is left alone", async () => {
    const tree = status(await call("GET", `/v1/organizations/${organizationId}/north/management-tree`, owner.cookie), 200);
    const evaluations = (tree.categories ?? tree).find((c: { slug: string }) => c.slug === "evaluations");
    status(await call("PATCH", `/v1/organizations/${organizationId}/categories/${evaluations.id}`, owner.cookie, { name: { es: "Otro", en: "Other" } }), 200);
    status(await call("POST", `/v1/organizations/${organizationId}/categories`, owner.cookie, { name: { en: "Extra" }, slug: "extra" }), 201);
    const fixed = await reconcileOrganization(as(owner.cookie), def);
    assert.equal(fixed.categoriesUpdated, 1);
    assert.equal(await prisma.northCategory.count({ where: { organizationId, slug: "extra" } }), 1);
  });

  await t.test("restricted and isolated: only the owner is a member; another account sees nothing", async () => {
    assert.equal(await prisma.membership.count({ where: { organizationId } }), 1);
    status(await call("GET", `/v1/organizations/${organizationId}/navigation`, stranger.cookie), 404);
    status(await call("GET", `/v1/organizations/${organizationId}/landing`, stranger.cookie), 403);
    const visible = status(await call("GET", "/v1/organizations", stranger.cookie), 200) as Array<{ id: string }>;
    assert.ok(!visible.some((o) => o.id === organizationId));
    // A non-member cannot reconcile into it: it would try to create the (taken) slug and be refused.
    await assert.rejects(reconcileOrganization(as(stranger.cookie), def), /409|403|404/);
  });
});
