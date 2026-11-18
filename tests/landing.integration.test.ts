import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/** ADR 027: stored landing policy, resolution per actor, validation, concurrency, tenant isolation, legacy compatibility. */
test("organization landing: modes, role/group rules, validation, tenant isolation, legacy parity", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5543?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5543, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let n = 0;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.${120 + Math.floor(n / 250)}.${(n++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
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
  const member = await account("member");
  const viewer = await account("viewer");
  const outsider = await account("outsider");
  const org = status(await call("POST", "/v1/organizations", owner.cookie, { name: `Landing ${prefix}` }), 201).id as string;
  const other = status(await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` }), 201).id as string;
  await prisma.membership.create({ data: { organizationId: org, userId: member.id, role: "MEMBER" } });
  await prisma.membership.create({ data: { organizationId: org, userId: viewer.id, role: "VIEWER" } });
  const base = `/v1/organizations/${org}`;
  const landing = `${base}/landing`;

  const panelIn = async (organization: string, cookie: string, slug: string, audience: object | null, publish = true) => {
    const b = `/v1/organizations/${organization}`;
    const category = status(await call("POST", `${b}/categories`, cookie, { name: { en: slug }, slug }), 201);
    const subcategory = status(await call("POST", `${b}/categories/${category.id}/subcategories`, cookie, { name: { en: "Main" }, slug: "main" }), 201);
    const panel = status(await call("POST", `${b}/subcategories/${subcategory.id}/panels`, cookie, { name: { en: slug }, slug: "page" }), 201);
    if (audience) status(await call("PUT", `${b}/panels/${panel.id}/audience`, cookie, audience), 200);
    if (publish) await prisma.northPanel.update({ where: { id: panel.id }, data: { status: "PUBLISHED" } });
    return panel.id as string;
  };
  const open = await panelIn(org, owner.cookie, "open", null);
  const adminsOnly = await panelIn(org, owner.cookie, "admins", { type: "ROLES", roles: ["OWNER", "ADMIN"] });
  const viewersOnly = await panelIn(org, owner.cookie, "viewers", { type: "ROLES", roles: ["VIEWER"] });
  const draft = await panelIn(org, owner.cookie, "draft", null, false);
  const foreign = await panelIn(other, outsider.cookie, "foreign", null);
  const group = status(await call("POST", `${base}/groups`, owner.cookie, { name: "Analysts" }), 201).id as string;
  status(await call("POST", `${base}/groups/${group}/members`, owner.cookie, { userId: member.id }), 201);
  const groupPanel = await panelIn(org, owner.cookie, "analysts", { type: "GROUPS", groupIds: [group] });
  const where = async (cookie: string) => (await (async () => status(await call("GET", `${landing}/resolve`, cookie), 200))()) as { mode: string; source: string; target: { categorySlug: string } | null };

  await t.test("an organization with no row resolves like before (homePanelId decides) and a legacy home keeps working", async () => {
    const view = status(await call("GET", landing, owner.cookie), 200);
    assert.equal(view.mode, "PANEL");
    assert.equal((await where(owner.cookie)).mode, "PANEL");
    await prisma.organization.update({ where: { id: org }, data: { homePanelId: null } });
    assert.equal((await where(owner.cookie)).mode, "STANDARD");
  });

  await t.test("PANEL mode persists, mirrors homePanelId and resolves to the panel", async () => {
    const saved = status(await call("PUT", landing, owner.cookie, { mode: "PANEL", defaultPanelId: open, rules: [] }), 200);
    assert.equal(saved.mode, "PANEL");
    assert.equal(status(await call("GET", landing, owner.cookie), 200).defaultPanelId, open);
    assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: org } })).homePanelId, open);
    const r = await where(member.cookie);
    assert.deepEqual([r.source, r.target?.categorySlug], ["default", "open"]);
  });

  await t.test("validation: mode/panel pairing, unpublished, foreign tenant and audience mismatch are rejected", async () => {
    const code = async (body: object, expected = 422) => status(await call("PUT", landing, owner.cookie, body), expected).error.code;
    assert.equal(await code({ mode: "PANEL", rules: [] }), "LANDING_PANEL_REQUIRED");
    assert.equal(await code({ mode: "STANDARD", defaultPanelId: open, rules: [] }), "LANDING_PANEL_NOT_ALLOWED");
    assert.equal(await code({ mode: "NONE", rules: [{ role: "VIEWER", panelId: open }] }), "LANDING_RULES_NOT_ALLOWED");
    assert.equal(await code({ mode: "PANEL", defaultPanelId: draft, rules: [] }), "LANDING_PANEL_INVALID");
    assert.equal(await code({ mode: "PANEL", defaultPanelId: foreign, rules: [] }), "LANDING_PANEL_INVALID");
    assert.equal(await code({ mode: "STANDARD", rules: [{ role: "VIEWER", panelId: adminsOnly }] }), "LANDING_PANEL_INVALID");
    assert.equal(await code({ mode: "STANDARD", rules: [{ role: "VIEWER", groupId: group, panelId: open }] }), "LANDING_RULE_INVALID");
    assert.equal(await code({ mode: "STANDARD", rules: [{ role: "VIEWER", panelId: open }, { role: "VIEWER", panelId: viewersOnly }] }, 409), "LANDING_RULE_CONFLICT");
    assert.equal(await code({ mode: "STANDARD", rules: [{ groupId: "cmforeign000000000000000000", panelId: open }] }), "LANDING_PANEL_INVALID");
  });

  await t.test("role and group rules win in order; others fall to the default; unauthorized targets fall through", async () => {
    status(await call("PUT", landing, owner.cookie, { mode: "PANEL", defaultPanelId: open, rules: [{ role: "VIEWER", panelId: viewersOnly }, { groupId: group, panelId: groupPanel }] }), 200);
    const viewerLands = await where(viewer.cookie);
    assert.deepEqual([viewerLands.source, viewerLands.target?.categorySlug], ["rule", "viewers"]);
    const memberLands = await where(member.cookie);
    assert.deepEqual([memberLands.source, memberLands.target?.categorySlug], ["rule", "analysts"]);
    assert.equal((await where(owner.cookie)).target?.categorySlug, "open");
    // Audience of the panel changes after the rule was saved: the viewer is no longer admitted and falls to the default.
    status(await call("PUT", `${base}/panels/${viewersOnly}/audience`, owner.cookie, { type: "ROLES", roles: ["ADMIN"] }), 200);
    assert.equal((await where(viewer.cookie)).target?.categorySlug, "open");
  });

  await t.test("NONE resolves to no target, STANDARD to the system home; a panel in use cannot be deleted", async () => {
    status(await call("PUT", landing, owner.cookie, { mode: "NONE", rules: [] }), 200);
    const none = await where(member.cookie);
    assert.deepEqual([none.source, none.target], ["none", null]);
    status(await call("PUT", landing, owner.cookie, { mode: "STANDARD", rules: [] }), 200);
    assert.equal((await where(member.cookie)).target?.categorySlug, "home");
    status(await call("PUT", landing, owner.cookie, { mode: "PANEL", defaultPanelId: open, rules: [{ groupId: group, panelId: groupPanel }] }), 200);
    assert.equal(status(await call("DELETE", `${base}/panels/${groupPanel}`, owner.cookie), 409).error.code, "LANDING_PANEL_IN_USE");
    // The default panel is additionally protected through the homePanelId mirror.
    status(await call("DELETE", `${base}/panels/${open}`, owner.cookie), 403);
  });

  await t.test("concurrent edits: a stale expectedUpdatedAt is refused", async () => {
    const current = status(await call("GET", landing, owner.cookie), 200);
    status(await call("PUT", landing, owner.cookie, { mode: "PANEL", defaultPanelId: open, rules: [], expectedUpdatedAt: current.updatedAt }), 200);
    assert.equal(status(await call("PUT", landing, owner.cookie, { mode: "NONE", rules: [], expectedUpdatedAt: current.updatedAt }), 409).error.code, "LANDING_CONFLICT");
  });

  await t.test("permissions and tenants: members cannot write or read the policy; outsiders and cross-tenant ids get nothing", async () => {
    status(await call("PUT", landing, member.cookie, { mode: "NONE", rules: [] }), 403);
    status(await call("GET", landing, member.cookie), 403);
    status(await call("GET", landing, outsider.cookie), 403);
    status(await call("GET", `${landing}/resolve`, outsider.cookie), 404);
    status(await call("PUT", `/v1/organizations/${other}/landing`, owner.cookie, { mode: "NONE", rules: [] }), 403);
    // The owner of another tenant cannot point THEIR landing at this organization's panel.
    assert.equal(status(await call("PUT", `/v1/organizations/${other}/landing`, outsider.cookie, { mode: "PANEL", defaultPanelId: open, rules: [] }), 422).error.code, "LANDING_PANEL_INVALID");
    assert.equal((await prisma.organizationLanding.count({ where: { organizationId: other } })), 0);
  });

  await t.test("the change is audited", async () => {
    assert.ok((await prisma.auditLog.count({ where: { organizationId: org, action: "NORTH_LANDING_UPDATED" } })) >= 5);
  });
});
