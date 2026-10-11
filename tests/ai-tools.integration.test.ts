import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

// Needs an isolated, migrated PostgreSQL database: TEST_DATABASE_URL=postgresql://.../xxx_test pnpm exec tsx --test tests/ai-tools.integration.test.ts
// The assistant's dashboard tools run as the signed-in user through the product's own services: they find panels, check real
// fields, query, produce UI directives, refuse unknown fields and other tenants, and administrative actions only run after the
// user confirms (re-authorized at that moment, single use, owner-bound).
test("assistant tools: dashboards, permissions, tenant isolation and confirmed actions", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5534?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";
  process.env.AI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-never-called";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5534, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { aiTools } = await import("../src/modules/ai/tool-registry.js");
  const { ai } = await import("../src/modules/ai/service.js");
  const { NorthDatasetImportMaterializationWorker } = await import("../src/modules/north/data/import-materialization-worker.js");
  const { StreamingDatasetImportMaterializer } = await import("../src/modules/north/data/import-materialization-parser.js");
  const scratch = mkdtempSync(join(tmpdir(), "ai-tools-"));
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); rmSync(scratch, { recursive: true, force: true }); });

  const origin = "http://localhost:3000";
  const password = "Test-password-only-123!";
  let address = 1;
  const prefix = randomUUID().slice(0, 8);
  const call = (method: "GET" | "POST" | "PATCH", url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `127.0.72.${address++ % 250 + 1}`, headers: { origin, ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const ok = (response: { statusCode: number; body: string }, status: number) => { assert.equal(response.statusCode, status, response.body); return JSON.parse(response.body); };
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    ok(await call("POST", "/v1/auth/sign-up/email", undefined, { email, password, name: label }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    ok(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await call("POST", "/v1/auth/sign-in/email", undefined, { email, password });
    ok(login, 200);
    return { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
  }
  const owner = await account("owner");
  const member = await account("member");
  const outsider = await account("outsider");
  const org = ok(await call("POST", "/v1/organizations", owner.cookie, { name: `Tools ${prefix}` }), 201).id as string;
  const otherOrg = ok(await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` }), 201).id as string;
  await prisma.membership.create({ data: { organizationId: org, userId: member.id, role: "MEMBER" } });

  // A real dataset (2,000 rows through the production worker), one panel with a paged grid binding, published.
  const rows = 2_000;
  const dataset = ok(await call("POST", `/v1/organizations/${org}/datasets`, owner.cookie, { name: { en: "Shipments" }, slug: "shipments" }), 201);
  const file = await writeXlsx(scratch, "shipments.xlsx", baseParts({ sheetXml: generatedSheet(rows) }));
  const ownerMembership = await prisma.membership.findFirstOrThrow({ where: { organizationId: org, userId: owner.id } });
  const job = await prisma.northDatasetImportJob.create({ data: {
    organizationId: org, datasetId: dataset.id, requestedBy: owner.id, requestedMembershipId: ownerMembership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(),
    requestHash: createHash("sha256").update("ai-tools").digest("hex"), filename: "shipments.xlsx", declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n,
    declaredChecksum: "a".repeat(64), storageKey: `opaque/${prefix}`, storageVersionId: "v1", status: "READY_TO_ACTIVATE", scanStatus: "APPROVED", confirmedAt: new Date(),
  } });
  const mapping = await prisma.northDatasetImportMappingVersion.create({ data: { organizationId: org, datasetId: dataset.id, importId: job.id, version: 1, sheetOrdinal: 0, headerRow: 1, createdBy: owner.id, definition: { duplicates: "KEEP", columns: [
    { sourceOrdinal: 0, action: "CREATE", key: "day", displayName: { en: "Day" }, canonicalType: "DATE", nullable: false },
    { sourceOrdinal: 1, action: "CREATE", key: "consignee", displayName: { en: "Consignee" }, canonicalType: "TEXT", nullable: false },
    { sourceOrdinal: 2, action: "CREATE", key: "weight", displayName: { en: "Weight" }, canonicalType: "DECIMAL", nullable: false },
  ] } as never } });
  await prisma.northDatasetImportJob.update({ where: { id: job.id }, data: { activationMappingId: mapping.id, activationRequestedBy: owner.id } });
  const worker = new NorthDatasetImportMaterializationWorker("ai-tools", new StreamingDatasetImportMaterializer({ async openPrivateRead() { return createReadStream(file); } } as never), { leaseMilliseconds: 300_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 1_000 });
  for (let attempt = 0; attempt < 10 && (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: job.id } })).status !== "SUCCEEDED"; attempt += 1) await worker.runOnce();
  const fields = ok(await call("GET", `/v1/organizations/${org}/datasets/${dataset.id}/fields`, owner.cookie), 200) as Array<{ id: string; key: string }>;
  const fieldId = (key: string) => fields.find((field) => field.key === key)!.id;
  const category = ok(await call("POST", `/v1/organizations/${org}/categories`, owner.cookie, { name: { en: "Reports" }, slug: "reports" }), 201);
  const subcategory = ok(await call("POST", `/v1/organizations/${org}/categories/${category.id}/subcategories`, owner.cookie, { name: { en: "Cargo" }, slug: "cargo" }), 201);
  const panel = ok(await call("POST", `/v1/organizations/${org}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { en: "Cargo table" }, slug: "cargo-table" }), 201);
  const filters = [{ fieldId: fieldId("consignee"), operators: ["IN", "EQ"] }, { fieldId: fieldId("day"), operators: ["GTE", "LTE"] }];
  const binding = ok(await call("POST", `/v1/organizations/${org}/panels/${panel.id}/analytics-bindings`, owner.cookie, { name: "results", datasetId: dataset.id, allowedFilters: filters,
    query: { mode: "AGGREGATE", groupBy: [fieldId("consignee")], measures: [{ operation: "COUNT", alias: "n" }, { operation: "SUM", fieldId: fieldId("weight"), alias: "kg" }], orderBy: [{ key: "n", direction: "DESC" }], limit: 50, includeTotal: true } }), 201).id as string;
  const cell = { x: 0, y: 0, w: 12, h: 8 };
  const draft = ok(await call("PATCH", `/v1/organizations/${org}/panels/${panel.id}/draft`, owner.cookie, { document: { schemaVersion: 1, defaultLocale: "en", fallbackLocales: [], sections: [{ id: "s1", order: 0, layout: { variant: "grid", gap: "md" }, components: [
    { id: "g", type: "data_grid", schemaVersion: 1, order: 0, props: { title: { en: "Results" }, columns: [{ key: fieldId("consignee"), label: { en: "Consignee" }, kind: "text" }, { key: "n", label: { en: "Rows" }, kind: "number" }], pageSizes: [10], defaultPageSize: 10 }, bindings: { data: { sourceType: "dataset", sourceId: binding, datasetId: dataset.id } }, layout: { desktop: cell, tablet: cell, mobile: cell } },
  ] }] } }), 200);
  const report = ok(await call("POST", `/v1/organizations/${org}/panels/${panel.id}/draft/validate`, owner.cookie), 200);
  ok(await call("POST", `/v1/organizations/${org}/panels/${panel.id}/publish`, owner.cookie, undefined, { "if-match": report.etag ?? draft.etag }), 200);

  const asOwner = { userId: owner.id, organizationId: org, application: "north" as const };
  const run = async (context: typeof asOwner, name: string, input: unknown) => (await aiTools.execute(context, name, input)).result as Record<string, unknown> & { ui?: Record<string, unknown> };

  await t.test("finds the dashboard, lists its real fields and answers from real rows", async () => {
    const found = await run(asOwner, "views.navigation.list", { query: "cargo" }) as { panels: Array<{ panelId: string; panelSlug: string }> };
    assert.equal(found.panels.length, 1);
    assert.equal(found.panels[0]!.panelId, panel.id);
    const described = await run(asOwner, "views.panel.describe", { panelId: panel.id }) as { dataSets: Array<{ name: string; filters: Array<{ key: string; operators: string[] }>; outputs: string[] }> };
    assert.deepEqual(described.dataSets[0]!.filters.map((filter) => filter.key).sort(), ["consignee", "day"]);
    const values = await run(asOwner, "views.values.search", { panelId: panel.id, dataSet: "results", field: "consignee", search: "CONSIGNEE 7 " }) as { values: Array<{ value: string; count: number }> };
    assert.ok(values.values.length >= 1 && values.values.every((entry) => entry.value.includes("CONSIGNEE 7")));
    const exact = values.values[0]!.value;
    const queried = await run(asOwner, "views.panel.query", { panelId: panel.id, dataSet: "results", filters: [{ field: "consignee", values: [exact] }] }) as { rows: Array<Record<string, string>>; totalRows: number };
    assert.equal(queried.totalRows, 1);
    assert.equal(queried.rows[0]![fieldId("consignee")], exact);
    assert.equal(Number(queried.rows[0]!.n), values.values[0]!.count);
  });

  await t.test("a field the dashboard does not have is refused with the real alternatives (no silent substitution)", async () => {
    await assert.rejects(run(asOwner, "views.apply_filters", { panelId: panel.id, filters: [{ field: "shipper", values: ["ACME"] }] }), (error: { code?: string; message?: string }) => error.code === "AI_FIELD_NOT_AVAILABLE" && /consignee/.test(error.message ?? ""));
    await assert.rejects(run(asOwner, "views.panel.query", { panelId: panel.id, dataSet: "results", filters: [{ field: "consignee", from: "2026-01-01" }] }), (error: { code?: string }) => error.code === "AI_FILTER_NOT_ALLOWED");
    await assert.rejects(run(asOwner, "views.panel.query", { panelId: panel.id, dataSet: "nope" }), (error: { code?: string }) => error.code === "AI_BINDING_UNKNOWN");
  });

  await t.test("applying filters verifies the match and returns a validated UI directive", async () => {
    await assert.rejects(run(asOwner, "views.apply_filters", { panelId: panel.id, filters: [{ field: "consignee", contains: "CONSIGNEE 1" }] }), (error: { code?: string }) => error.code === "AI_FILTER_NOT_ALLOWED", "a text search is never degraded into an exact match");
    const picked = (await run(asOwner, "views.values.search", { panelId: panel.id, dataSet: "results", field: "consignee", search: "CONSIGNEE 1 ", limit: 3 }) as { values: Array<{ value: string }> }).values.map((entry) => entry.value);
    const applied = await run(asOwner, "views.apply_filters", { panelId: panel.id, filters: [{ field: "consignee", values: picked }, { field: "day", from: "2024-01-01", to: "2026-12-31" }] });
    assert.equal(applied.applied, true);
    assert.equal(Number(applied.matchingRows), picked.length);
    assert.equal(applied.ui?.type, "apply_filters");
    assert.equal(applied.ui?.panelId, panel.id);
    assert.equal((await run(asOwner, "views.clear_filters", { panelId: panel.id })).ui?.type, "clear_filters");
  });

  await t.test("tenant isolation: another organization's member sees nothing and cannot name this panel", async () => {
    const asOutsider = { userId: outsider.id, organizationId: otherOrg, application: "north" as const };
    const theirs = (await run(asOutsider, "views.navigation.list", {})) as { panels: Array<{ panelId: string }> };
    assert.ok(!theirs.panels.some((entry) => entry.panelId === panel.id), "another tenant's navigation never lists this panel");
    await assert.rejects(run(asOutsider, "views.panel.describe", { panelId: panel.id }));
    await assert.rejects(run({ ...asOutsider, organizationId: org }, "views.navigation.list", {}), "a user cannot act in an organization they do not belong to");
  });

  await t.test("administrative actions are proposed, gated by permission, and run only once after the user confirms", async () => {
    const asMember = { userId: member.id, organizationId: org, application: "north" as const };
    // A plain member is refused at PROPOSAL time; the owner may propose.
    await assert.rejects(aiTools.propose(asMember, "views.category.create", { name: "Finance" }), (error: { code?: string }) => error.code === "AI_PERMISSION_DENIED");
    const proposal = await aiTools.propose(asOwner, "views.category.create", { name: `Finance ${prefix}`, slug: `finance-${prefix}` });
    assert.match(proposal.summary, /Finance/);
    assert.equal(await prisma.northCategory.count({ where: { organizationId: org, slug: `finance-${prefix}` } }), 0, "proposing changes nothing");
    // Read-only execution of a mutation tool is impossible.
    await assert.rejects(aiTools.execute(asOwner, "views.category.create", { name: "x" }));

    const conversation = await prisma.aIConversation.create({ data: { organizationId: org, userId: owner.id, application: "NORTH" } });
    const aiRun = await prisma.aIRun.create({ data: { conversationId: conversation.id, organizationId: org, userId: owner.id, application: "NORTH", status: "COMPLETED", provider: "gemini", model: "test", completedAt: new Date() } });
    const action = await prisma.aIAction.create({ data: { runId: aiRun.id, organizationId: org, userId: owner.id, toolName: "views.category.create", arguments: { input: proposal.input, summary: proposal.summary } as never, expiresAt: new Date(Date.now() + 600_000) } });
    // Only the user who owns the run can confirm it.
    await assert.rejects(ai.confirmAction(member.id, action.id), (error: { statusCode?: number }) => error.statusCode === 404);
    assert.equal(await prisma.northCategory.count({ where: { organizationId: org, slug: `finance-${prefix}` } }), 0);
    const confirmed = await ai.confirmAction(owner.id, action.id);
    assert.equal(confirmed.status, "CONFIRMED");
    assert.equal(await prisma.northCategory.count({ where: { organizationId: org, slug: `finance-${prefix}` } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { organizationId: org, action: "ai.action.confirmed", targetId: action.id } }), 1, "the confirmation is audited");
    // Single use: a second confirmation never executes again.
    await assert.rejects(ai.confirmAction(owner.id, action.id), (error: { code?: string }) => error.code === "AI_ACTION_NOT_PENDING");
    assert.equal(await prisma.northCategory.count({ where: { organizationId: org, slug: `finance-${prefix}` } }), 1);
    // An expired action never runs.
    const stale = await prisma.aIAction.create({ data: { runId: aiRun.id, organizationId: org, userId: owner.id, toolName: "views.category.create", arguments: { input: { name: "Late", slug: `late-${prefix}` }, summary: "x" } as never, expiresAt: new Date(Date.now() - 1_000) } });
    await assert.rejects(ai.confirmAction(owner.id, stale.id), (error: { code?: string }) => error.code === "AI_ACTION_EXPIRED");
    assert.equal(await prisma.northCategory.count({ where: { organizationId: org, slug: `late-${prefix}` } }), 0);
  });
});
