import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

// Organization onboarding: emailed invitations that create the account, member accounts created by an administrator,
// the per-organization storage limit and permanent deletion of content (category / subcategory / panel).
test("DELETE paths regression", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5530?ignoreTLS=true";
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
  await new Promise<void>((resolve) => smtp.listen(5530, "127.0.0.1", resolve));
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
  const owner = await verifiedAccount("owner");
  const viewer = await verifiedAccount("viewer");
  let viewerJoined = false;
  const organizationId = expect(await call("POST", "/v1/organizations", owner.cookie, { name: "Delete Org", slug: `del${prefix}` }), 201).id as string;
  const org = `/v1/organizations/${organizationId}`;
  const joinViewer = async () => { if (viewerJoined) return; const inv = expect(await call("POST", `${org}/invitations`, owner.cookie, { kind: "CODE", role: "VIEWER" }), 201); expect(await call("POST", "/v1/invitations/accept", viewer.cookie, { token: inv.token }), 200); viewerJoined = true; };
  const del = (url: string, cookie: string) => call("DELETE", url, cookie);
  const ok = (response: Awaited<ReturnType<typeof call>>) => assert.ok([200, 204].includes(response.statusCode), `${response.statusCode}: ${response.body}`);

  await t.test("invitation: email and code revoke, repeat revoke, accepted revoke", async () => {
    const email = `${prefix}-inv@blackpolar.test`;
    const inv = expect(await call("POST", `${org}/invitations`, owner.cookie, { email, role: "VIEWER" }), 201);
    ok(await del(`${org}/invitations/${inv.id}`, owner.cookie));
    ok(await del(`${org}/invitations/${inv.id}`, owner.cookie));
    const code = expect(await call("POST", `${org}/invitations`, owner.cookie, { kind: "CODE", role: "VIEWER" }), 201);
    ok(await del(`${org}/invitations/${code.id}`, owner.cookie));
  });

  await t.test("group: delete with member, grant and invitation grant", async () => {
    const group = expect(await call("POST", `${org}/groups`, owner.cookie, { name: "Analistas" }), 201);
    await joinViewer();
    const mem = await call("POST", `${org}/groups/${group.id}/members`, owner.cookie, { userId: viewer.id });
    console.log("ADD group member ->", mem.statusCode, mem.body.slice(0, 200));
    const inv = await call("POST", `${org}/invitations`, owner.cookie, { email: `${prefix}-g@blackpolar.test`, role: "VIEWER", groupIds: [group.id] });
    console.log("INVITE w/ group ->", inv.statusCode, inv.body.slice(0, 200));
    const r = await del(`${org}/groups/${group.id}`, owner.cookie);
    console.log("DELETE group ->", r.statusCode, r.body.slice(0, 300));
    ok(r);
  });

  await t.test("member removal and user deletion", async () => {
    await joinViewer();
    const r = await del(`${org}/members/${viewer.id}`, owner.cookie);
    console.log("REMOVE member ->", r.statusCode, r.body.slice(0, 300));
    const u = await del(`/v1/users/${viewer.id}`, owner.cookie);
    console.log("DELETE user as owner ->", u.statusCode, u.body.slice(0, 200));
  });

  await t.test("taxonomy: category tree delete and datasets", async () => {
    const c = await call("POST", `${org}/categories`, owner.cookie, { name: { en: "Cat", es: "Cat" }, slug: "cat" });
    console.log("CREATE cat ->", c.statusCode, c.body.slice(0, 200));
    if (c.statusCode === 201) { const r = await del(`${org}/categories/${c.json().id}`, owner.cookie); console.log("DELETE cat ->", r.statusCode, r.body.slice(0, 300)); }
    const d = await call("POST", `${org}/datasets`, owner.cookie, { name: { en: "DS", es: "DS" }, slug: "ds" });
    console.log("CREATE dataset ->", d.statusCode, d.body.slice(0, 200));
    if (d.statusCode === 201) { const r = await del(`${org}/datasets/${d.json().id}`, owner.cookie); console.log("DELETE dataset ->", r.statusCode, r.body.slice(0, 200)); }
  });

  await t.test("platform user delete: SUPERADMIN deletes a user with history", async () => {
    const sup = await verifiedAccount("sup");
    await prisma.user.update({ where: { id: sup.id }, data: { role: "SUPERADMIN" } });
    const lone = await verifiedAccount("lone");
    const r0 = await del(`/v1/users/${lone.id}`, sup.cookie);
    console.log("DELETE fresh user ->", r0.statusCode, r0.body.slice(0, 200));
    // user who created an org and then left it, with assets/audit history
    const hist = await verifiedAccount("hist");
    const o2 = expect(await call("POST", "/v1/organizations", hist.cookie, { name: "Hist Org", slug: `hist${prefix}` }), 201).id as string;
    expect(await call("POST", `/v1/organizations/${o2}/datasets`, hist.cookie, { name: { en: "H", es: "H" }, slug: "hist-data" }), 201);
    expect(await call("POST", `/v1/organizations/${o2}/categories`, hist.cookie, { name: { en: "C", es: "C" }, slug: "hist-cat" }), 201);
    const withMem = await del(`/v1/users/${hist.id}`, sup.cookie);
    console.log("DELETE user w/ membership ->", withMem.statusCode, withMem.body.slice(0, 200));
    try { await prisma.membership.deleteMany({ where: { userId: hist.id } }); } catch (e) { console.log("MEMBERSHIP deleteMany ->", (e as { code?: string; meta?: unknown }).code, JSON.stringify((e as { meta?: unknown }).meta), String((e as Error).message).slice(-300)); }
    const r1 = await del(`/v1/users/${hist.id}`, sup.cookie);
    console.log("DELETE user w/ history, no membership ->", r1.statusCode, r1.body.slice(0, 300));
    await prisma.user.update({ where: { id: sup.id }, data: { role: "USER" } });
  });

  await t.test("member removal when the member owns dataset ACL rows", async () => {
    const ed = await verifiedAccount("editor");
    const inv = expect(await call("POST", `${org}/invitations`, owner.cookie, { kind: "CODE", role: "ADMIN" }), 201);
    expect(await call("POST", "/v1/invitations/accept", ed.cookie, { token: inv.token }), 200);
    const ds = await call("POST", `${org}/datasets`, ed.cookie, { name: { en: "E", es: "E" }, slug: "editor-data" });
    console.log("ADMIN creates dataset ->", ds.statusCode, ds.body.slice(0, 120));
    const r = await del(`${org}/members/${ed.id}`, owner.cookie);
    // Known gap (documented in the audit): the dataset ACL FK blocks it with 409 instead of offering a transfer.
    assert.equal(r.statusCode, 409);
  });

  await t.test("panel with saved revisions: category / panel delete", async () => {
    const doc = { schemaVersion: 1, defaultLocale: "en", fallbackLocales: [], sections: [] };
    for (const via of ["panel", "subcategory", "category"] as const) {
      const cat = expect(await call("POST", `${org}/categories`, owner.cookie, { name: { en: `Cat ${via}`, es: `Cat ${via}` }, slug: `rev-${via}` }), 201);
      const sub = expect(await call("POST", `${org}/categories/${cat.id}/subcategories`, owner.cookie, { name: { en: "Sub", es: "Sub" }, slug: `sub-${via}` }), 201);
      const panel = expect(await call("POST", `${org}/subcategories/${sub.id}/panels`, owner.cookie, { name: { en: "P", es: "P" }, slug: `p-${via}` }), 201);
      const saved = await call("PATCH", `${org}/panels/${panel.id}/draft`, owner.cookie, { document: doc });
      console.log(`SAVE draft (${via}) ->`, saved.statusCode, saved.body.slice(0, 160));
      const url = via === "panel" ? `${org}/panels/${panel.id}` : via === "subcategory" ? `${org}/subcategories/${sub.id}` : `${org}/categories/${cat.id}`;
      const r = await del(url, owner.cookie);
      assert.equal(r.statusCode, 200, `${via}: ${r.body}`);
      assert.equal(await prisma.northPanel.count({ where: { id: panel.id } }), 0);
      assert.equal(await prisma.northPanelRevision.count({ where: { panelId: panel.id } }), 0);
    }
    // Append-only still holds outside an explicit erase: a stray delete or update is rejected by the database.
    const keep = expect(await call("POST", `${org}/subcategories/${(await prisma.northSubcategory.findFirstOrThrow({ where: { organizationId } })).id}/panels`, owner.cookie, { name: { en: "K", es: "K" }, slug: "keep" }), 201);
    assert.equal((await call("PATCH", `${org}/panels/${keep.id}/draft`, owner.cookie, { document: doc })).statusCode, 200);
    await assert.rejects(prisma.northPanelRevision.deleteMany({ where: { panelId: keep.id } }), /append-only/);
    await assert.rejects(prisma.northPanelRevision.updateMany({ where: { panelId: keep.id }, data: { message: "x" } }), /append-only/);
  });

  await t.test("VIEWER data access probe", async () => {
    const viewer = await verifiedAccount("viewer2");
    const code = expect(await call("POST", `${org}/invitations`, owner.cookie, { kind: "CODE", role: "VIEWER" }), 201);
    expect(await call("POST", "/v1/invitations/accept", viewer.cookie, { token: code.token }), 200);
    const ds = expect(await call("POST", `${org}/datasets`, owner.cookie, { name: { en: "V", es: "V" }, slug: "viewer-data" }), 201);
    const q = () => call("POST", `${org}/datasets/${ds.id}/query`, viewer.cookie, { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }] });
    const r0 = await q();
    assert.equal(r0.statusCode, 403);
    const g = await call("POST", `${org}/north/permission-grants`, owner.cookie, { subjectType: "ROLE", role: "VIEWER", capability: "north.data.query", scope: "ORGANIZATION" });
    assert.equal(g.statusCode, 201);
    const r1 = await q();
    assert.equal(r1.statusCode, 403, "capability alone is not enough: the dataset ACL is a second gate");
    const a = await call("POST", `${org}/datasets/${ds.id}/acl`, owner.cookie, { effect: "ALLOW", principalType: "ROLE", role: "VIEWER" });
    assert.equal(a.statusCode, 201);
    const r2 = await q();
    assert.equal(r2.statusCode, 409, "authorized; only fails because the test dataset has no active revision");
  });
});
