import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/** ADR 027 / D3: per-component visibility is enforced on the server for published documents. */
test("component visibility: restricted blocks are never delivered to members who do not match", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5544?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5544, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let n = 0;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `127.0.${130 + Math.floor(n / 250)}.${(n++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...headers, ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const status = (response: Res, expected: number) => { assert.equal(response.statusCode, expected, `${response.statusCode}: ${response.body}`); return response.json(); };
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    status(await call("POST", "/v1/auth/sign-up/email", undefined, { email, password, name: label }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    status(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await call("POST", "/v1/auth/sign-in/email", undefined, { email, password });
    status(login, 200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { id: user.id, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
  }

  const owner = await account("owner");
  const analyst = await account("analyst");
  const viewer = await account("viewer");
  const outsider = await account("outsider");
  const org = status(await call("POST", "/v1/organizations", owner.cookie, { name: `Vis ${prefix}` }), 201).id as string;
  const other = status(await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` }), 201).id as string;
  await prisma.membership.create({ data: { organizationId: org, userId: analyst.id, role: "VIEWER" } });
  await prisma.membership.create({ data: { organizationId: org, userId: viewer.id, role: "VIEWER" } });
  const base = `/v1/organizations/${org}`;
  const group = status(await call("POST", `${base}/groups`, owner.cookie, { name: "Analysts" }), 201).id as string;
  status(await call("POST", `${base}/groups/${group}/members`, owner.cookie, { userId: analyst.id }), 201);
  const otherGroup = status(await call("POST", `/v1/organizations/${other}/groups`, outsider.cookie, { name: "Foreign" }), 201).id as string;

  const category = status(await call("POST", `${base}/categories`, owner.cookie, { name: { en: "Pages" }, slug: "pages" }), 201);
  const subcategory = status(await call("POST", `${base}/categories/${category.id}/subcategories`, owner.cookie, { name: { en: "Main" }, slug: "main" }), 201);
  const panel = status(await call("POST", `${base}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { en: "Page" }, slug: "page" }), 201);
  const cell = { desktop: { x: 0, y: 0, w: 4, h: 2 }, tablet: { x: 0, y: 0, w: 4, h: 2 }, mobile: { x: 0, y: 0, w: 4, h: 2 } };
  const heading = (id: string, text: string, visibility?: object) => ({ id, type: "heading", schemaVersion: 1, props: { text: { en: text }, level: 2 }, bindings: {}, order: 0, layout: cell, ...(visibility ? { visibility } : {}) });
  const documentOf = (components: unknown[]) => ({ schemaVersion: 1, defaultLocale: "en", fallbackLocales: [], sections: [{ id: "s1", order: 0, layout: { variant: "grid", gap: "md" }, components }] });
  const save = (components: unknown[], cookie = owner.cookie) => call("PATCH", `${base}/panels/${panel.id}/draft`, cookie, { document: documentOf(components) });

  await t.test("validation: needs a role or group, groups must belong to this organization", async () => {
    assert.equal(status(await save([heading("a", "A", {})]), 422).error.code, "PANEL_DOCUMENT_INVALID");
    assert.equal(status(await save([heading("a", "A", { groupIds: [otherGroup] })]), 422).error.code, "VISIBILITY_GROUP_INVALID");
    assert.equal(status(await save([heading("a", "A", { roles: ["EMPEROR"] })]), 422).error.code, "PANEL_DOCUMENT_INVALID");
  });

  await t.test("published document is filtered per member; the draft and the rules stay with editors", async () => {
    const draft = await save([heading("open", "Everyone"), heading("owners", "Owners only", { roles: ["OWNER"] }), heading("analysts", "Analysts only", { groupIds: [group] })]);
    status(draft, 200);
    status(await call("POST", `${base}/panels/${panel.id}/publish`, owner.cookie, undefined, { "if-match": draft.headers.etag as string }), 200);
    const resolve = async (cookie: string) => {
      const r = status(await call("GET", `/v1/content/resolve?organizationSlug=${encodeURIComponent((await prisma.organization.findUniqueOrThrow({ where: { id: org } })).slug)}&categorySlug=pages&subcategorySlug=main&panelSlug=page`, cookie), 200);
      return r.revision.document.sections[0].components.map((c: { id: string }) => c.id) as string[];
    };
    assert.deepEqual(await resolve(owner.cookie), ["open", "owners"]);
    assert.deepEqual(await resolve(analyst.cookie), ["open", "analysts"]);
    assert.deepEqual(await resolve(viewer.cookie), ["open"]);
    const raw = JSON.stringify(status(await call("GET", `${base}/panels/${panel.id}/draft`, owner.cookie), 200).document);
    assert.ok(raw.includes("visibility") && raw.includes("owners"));
  });
});
