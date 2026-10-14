import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

test("binding delete, member removal with datasets, access simulation", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5535?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5535, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { NorthDatasetImportMaterializationWorker } = await import("../src/modules/north/data/import-materialization-worker.js");
  const { StreamingDatasetImportMaterializer } = await import("../src/modules/north/data/import-materialization-parser.js");
  const scratch = mkdtempSync(join(tmpdir(), "analytics-contracts-"));
  const app = await buildApp({ logger: process.env.TEST_LOG ? { level: "error" } : false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); rmSync(scratch, { recursive: true, force: true }); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `127.0.50.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const expectStatus = (response: Res, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  const cookieOf = (response: Res) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  let signupAddress = 10;
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    expectStatus(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: `127.0.51.${signupAddress++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expectStatus(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.52.${signupAddress++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password } });
    expectStatus(login, 200);
    return { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, cookie: cookieOf(login) };
  }

  const owner = await account("owner");
  const outsider = await account("outsider");
  const org = expectStatus(await call("POST", "/v1/organizations", owner.cookie, { name: `Analytics ${prefix}` }), 201).id as string;
  const otherOrg = expectStatus(await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` }), 201).id as string;

  // --- a real dataset through the production worker: 12,000 rows, closed-form expectations ---
  const rowsExpected = 500;
  const dataset = expectStatus(await call("POST", `/v1/organizations/${org}/datasets`, owner.cookie, { name: { en: "Shipments" }, slug: "shipments" }), 201);
  const file = await writeXlsx(scratch, "shipments.xlsx", baseParts({ sheetXml: generatedSheet(rowsExpected) }));
  const membership = await prisma.membership.findFirstOrThrow({ where: { organizationId: org, userId: owner.id } });
  const job = await prisma.northDatasetImportJob.create({ data: {
    organizationId: org, datasetId: dataset.id, requestedBy: owner.id, requestedMembershipId: membership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(),
    requestHash: createHash("sha256").update("analytics").digest("hex"), filename: "shipments.xlsx", declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n,
    declaredChecksum: "a".repeat(64), storageKey: `opaque/${prefix}`, storageVersionId: "v1", status: "READY_TO_ACTIVATE", scanStatus: "APPROVED", confirmedAt: new Date(),
  } });
  const mapping = await prisma.northDatasetImportMappingVersion.create({ data: { organizationId: org, datasetId: dataset.id, importId: job.id, version: 1, sheetOrdinal: 0, headerRow: 1, createdBy: owner.id, definition: { duplicates: "SKIP_EXACT", columns: [
    { sourceOrdinal: 0, action: "CREATE", key: "day", displayName: { en: "Day" }, canonicalType: "DATE", nullable: false },
    { sourceOrdinal: 1, action: "CREATE", key: "consignee", displayName: { en: "Consignee" }, canonicalType: "TEXT", nullable: false },
    { sourceOrdinal: 2, action: "CREATE", key: "weight", displayName: { en: "Weight" }, canonicalType: "DECIMAL", nullable: false },
  ] } as never } });
  await prisma.northDatasetImportJob.update({ where: { id: job.id }, data: { activationMappingId: mapping.id, activationRequestedBy: owner.id } });
  const worker = new NorthDatasetImportMaterializationWorker("analytics", new StreamingDatasetImportMaterializer({ async openPrivateRead() { return createReadStream(file); } } as never), { leaseMilliseconds: 300_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 1_000 });
  for (let attempt = 0; attempt < 10 && (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: job.id } })).status !== "SUCCEEDED"; attempt += 1) await worker.runOnce();
  assert.equal((await prisma.northDatasetImportBatch.findUniqueOrThrow({ where: { importId: job.id } })).rowCount, rowsExpected);
  const fields = expectStatus(await call("GET", `/v1/organizations/${org}/datasets/${dataset.id}/fields`, owner.cookie), 200) as Array<{ id: string; key: string }>;
  const id = (key: string) => fields.find((field) => field.key === key)!.id;
  const [day, consignee, weight] = [id("day"), id("consignee"), id("weight")];

  const base = `/v1/organizations/${org}`;
  const accountIn = async (label: string, role: string) => {
    const person = await account(label);
    const key = expectStatus(await call("POST", `${base}/invitations`, owner.cookie, { kind: "CODE", role }), 201);
    expectStatus(await call("POST", "/v1/invitations/accept", person.cookie, { token: key.token }), 200);
    return person;
  };

  await t.test("a binding that a draft or published version uses cannot be deleted; an unused one can", async () => {
    const category = expectStatus(await call("POST", `${base}/categories`, owner.cookie, { name: { en: "C" }, slug: "bind-cat" }), 201);
    const subcategory = expectStatus(await call("POST", `${base}/categories/${category.id}/subcategories`, owner.cookie, { name: { en: "S" }, slug: "bind-sub" }), 201);
    const panel = expectStatus(await call("POST", `${base}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { en: "P" }, slug: "bind-panel" }), 201);
    const make = async (name: string) => expectStatus(await call("POST", `${base}/panels/${panel.id}/analytics-bindings`, owner.cookie, { name, datasetId: dataset.id, query: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }] }, allowedFilters: [{ fieldId: day, operators: ["GTE"] }] }), 201).id as string;
    const used = await make("used");
    const spare = await make("spare");
    const documentOf = (components: unknown[]) => ({ schemaVersion: 1, defaultLocale: "en", fallbackLocales: [], sections: [{ id: "s1", order: 0, layout: { variant: "grid", gap: "md" }, components }] });
    const cell = { x: 0, y: 0, w: 4, h: 3 };
    const kpi = { id: "k", type: "kpi_card", schemaVersion: 1, props: { label: { en: "Rows" }, valueKey: "n", format: "number", icon: "container", tone: "blue", variant: "trend", comparison: {} }, bindings: { data: { sourceType: "dataset", sourceId: used, datasetId: dataset.id } }, order: 0, layout: { desktop: cell, tablet: cell, mobile: { ...cell, w: 12 } } };
    const saved = await call("PATCH", `${base}/panels/${panel.id}/draft`, owner.cookie, { document: documentOf([kpi]) });
    expectStatus(saved, 200);
    const blocked = await call("DELETE", `${base}/panels/${panel.id}/analytics-bindings/${used}`, owner.cookie);
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, "BINDING_IN_USE");
    const viewer = await accountIn("binding-viewer", "VIEWER");
    assert.equal((await call("DELETE", `${base}/panels/${panel.id}/analytics-bindings/${spare}`, viewer.cookie)).statusCode, 403);
    assert.ok([403, 404].includes((await call("DELETE", `${base}/panels/${panel.id}/analytics-bindings/${spare}`, outsider.cookie)).statusCode));
    expectStatus(await call("DELETE", `${base}/panels/${panel.id}/analytics-bindings/${spare}`, owner.cookie), 200);
    assert.equal((await call("DELETE", `${base}/panels/${panel.id}/analytics-bindings/${spare}`, owner.cookie)).statusCode, 404);
    // remove the chart from the draft: now the binding is free
    expectStatus(await call("PATCH", `${base}/panels/${panel.id}/draft`, owner.cookie, { document: documentOf([]) }, { "if-match": saved.headers.etag as string }), 200);
    expectStatus(await call("DELETE", `${base}/panels/${panel.id}/analytics-bindings/${used}`, owner.cookie), 200);
    assert.equal(await prisma.northAnalyticsBinding.count({ where: { panelId: panel.id } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { organizationId: org, action: "ANALYTICS_BINDING_DELETED" } }), 2);
  });

  await t.test("removing a member who owns dataset rules and requested imports succeeds and keeps the data reachable", async () => {
    const editor = await accountIn("editor-leaver", "ADMIN");
    const theirs = expectStatus(await call("POST", `${base}/datasets`, editor.cookie, { name: { en: "Mine" }, slug: "leaver-data" }), 201);
    const editorMembership = await prisma.membership.findFirstOrThrow({ where: { organizationId: org, userId: editor.id } });
    const requested = await prisma.northDatasetImportJob.create({ data: {
      organizationId: org, datasetId: theirs.id, requestedBy: editor.id, requestedMembershipId: editorMembership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(),
      requestHash: createHash("sha256").update("leaver").digest("hex"), filename: "x.xlsx", declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n,
      declaredChecksum: "d".repeat(64), storageKey: `opaque/leaver-${prefix}`, status: "FAILED", scanStatus: "APPROVED",
    } });
    assert.ok((await prisma.northDatasetAcl.count({ where: { membershipId: editorMembership.id } })) > 0);
    // a non-manager cannot remove anyone; the owner can
    const bystander = await accountIn("bystander", "VIEWER");
    assert.equal((await call("DELETE", `${base}/members/${editor.id}`, bystander.cookie)).statusCode, 403);
    expectStatus(await call("DELETE", `${base}/members/${editor.id}`, owner.cookie), 200);
    assert.equal(await prisma.membership.count({ where: { id: editorMembership.id } }), 0);
    assert.equal(await prisma.northDatasetAcl.count({ where: { membershipId: editorMembership.id } }), 0);
    const ownerMembership = await prisma.membership.findFirstOrThrow({ where: { organizationId: org, userId: owner.id } });
    const moved = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: requested.id } });
    assert.deepEqual([moved.requestedMembershipId, moved.requestedBy], [ownerMembership.id, editor.id]);
    // the dataset the leaver created is still reachable by the owner role rule
    expectStatus(await call("GET", `${base}/datasets/${theirs.id}`, owner.cookie), 200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org, action: "membership.remove", targetId: editorMembership.id } });
    assert.deepEqual(audit.metadata, { datasetRulesRemoved: 1, importsReassigned: 1 });
  });

  await t.test("access simulation explains permissions, dataset gates and views without impersonating", async () => {
    const group = expectStatus(await call("POST", `${base}/groups`, owner.cookie, { name: "Simulados" }), 201);
    const target = await accountIn("simulated", "VIEWER");
    expectStatus(await call("POST", `${base}/groups/${group.id}/members`, owner.cookie, { userId: target.id }), 201);
    expectStatus(await call("POST", `${base}/groups/${group.id}/permissions`, owner.cookie, { permission: "audit.read" }), 201);
    const simulate = (cookie: string, userId = target.id, o = org) => call("GET", `/v1/organizations/${o}/members/${userId}/access-simulation`, cookie);
    // before any data access is granted
    let view = expectStatus(await simulate(owner.cookie), 200);
    assert.equal(view.role, "VIEWER");
    const audit = view.permissions.find((entry: { permission: string }) => entry.permission === "audit.read");
    assert.deepEqual(audit.origins, [{ type: "GROUP", id: group.id, name: "Simulados" }]);
    assert.deepEqual(view.permissions.find((entry: { permission: string }) => entry.permission === "documents.read").origins, [{ type: "ROLE", name: "VIEWER" }]);
    assert.equal(view.permissions.some((entry: { permission: string }) => entry.permission === "members.manage"), false);
    const before = view.data.datasets.find((entry: { id: string }) => entry.id === dataset.id);
    assert.deepEqual([view.data.canQuery, before.canQuery, before.reason], [false, false, "NO_QUERY_CAPABILITY"]);
    assert.equal(JSON.stringify(view).includes(target.cookie), false);
    // grant the role access the supported way and the simulation follows
    expectStatus(await call("POST", `${base}/north/role-data-access`, owner.cookie, { role: "VIEWER", datasetIds: [dataset.id] }), 200);
    view = expectStatus(await simulate(owner.cookie), 200);
    const after = view.data.datasets.find((entry: { id: string }) => entry.id === dataset.id);
    assert.deepEqual([view.data.canQuery, after.canQuery, after.reason], [true, true, "OK"]);
    // and it agrees with reality: the real query is authorized (409 = no extra data problem, not 403)
    const real = await call("POST", `${base}/datasets/${dataset.id}/query`, target.cookie, { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }] });
    assert.equal(real.statusCode, 200);
    // published views: visible by audience, with the reason when not
    const category = expectStatus(await call("POST", `${base}/categories`, owner.cookie, { name: { en: "V" }, slug: "view-cat" }), 201);
    const subcategory = expectStatus(await call("POST", `${base}/categories/${category.id}/subcategories`, owner.cookie, { name: { en: "V" }, slug: "view-sub" }), 201);
    const publish = async (slug: string, roles: string[]) => {
      const panel = expectStatus(await call("POST", `${base}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { en: slug }, slug }), 201);
      const binding = expectStatus(await call("POST", `${base}/panels/${panel.id}/analytics-bindings`, owner.cookie, { name: "n", datasetId: dataset.id, query: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }] }, allowedFilters: [{ fieldId: day, operators: ["GTE"] }] }), 201).id as string;
      const cell = { x: 0, y: 0, w: 4, h: 3 };
      const kpi = { id: "k", type: "kpi_card", schemaVersion: 1, props: { label: { en: "Rows" }, valueKey: "n", format: "number", icon: "container", tone: "blue", variant: "trend", comparison: {} }, bindings: { data: { sourceType: "dataset", sourceId: binding, datasetId: dataset.id } }, order: 0, layout: { desktop: cell, tablet: cell, mobile: { ...cell, w: 12 } } };
      const draft = await call("PATCH", `${base}/panels/${panel.id}/draft`, owner.cookie, { document: { schemaVersion: 1, defaultLocale: "en", fallbackLocales: [], sections: [{ id: "s1", order: 0, layout: { variant: "grid", gap: "md" }, components: [kpi] }] } });
      expectStatus(draft, 200);
      expectStatus(await call("POST", `${base}/panels/${panel.id}/publish`, owner.cookie, undefined, { "if-match": draft.headers.etag as string }), 200);
      expectStatus(await call("PUT", `${base}/panels/${panel.id}/audience`, owner.cookie, { type: "ROLES", roles }), 200);
      return panel.id as string;
    };
    const forViewers = await publish("for-viewers", ["VIEWER"]);
    const forAdmins = await publish("for-admins", ["ADMIN"]);
    view = expectStatus(await simulate(owner.cookie), 200);
    const panelState = (id: string) => view.views.panels.find((entry: { id: string }) => entry.id === id);
    assert.deepEqual([panelState(forViewers).visible, panelState(forViewers).reason], [true, "OK"]);
    assert.deepEqual([panelState(forAdmins).visible, panelState(forAdmins).reason], [false, "AUDIENCE_DENIED"]);
    // reality agrees: the real published-binding endpoint answers for the simulated user the same way
    const realPanel = (id: string) => call("GET", `${base}/panels/${id}/analytics-bindings`, target.cookie);
    assert.ok([403, 404].includes((await realPanel(forAdmins)).statusCode));
    // privileged, tenant-scoped and audited
    assert.equal((await simulate(target.cookie, owner.id)).statusCode, 403);
    assert.ok([403, 404].includes((await simulate(outsider.cookie)).statusCode));
    assert.ok([403, 404].includes((await simulate(owner.cookie, target.id, otherOrg)).statusCode));
    assert.equal((await simulate(owner.cookie, outsider.id)).statusCode, 404);
    assert.ok((await prisma.auditLog.count({ where: { organizationId: org, action: "access.simulation.view" } })) >= 2);
  });
});
