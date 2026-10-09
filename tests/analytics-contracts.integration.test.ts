import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

// Needs an isolated, migrated PostgreSQL database: TEST_DATABASE_URL=postgresql://.../xxx_test pnpm exec tsx --test tests/analytics-contracts.integration.test.ts
// Exercises the dashboard contracts over HTTP (so response serialization is covered): paged/sorted/searched/compared binding
// results, facets (search, paging, date buckets), the new document components, organization brand colors and tenant isolation.
test("analytics contracts: bindings, facets, components and branding over HTTP", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5531?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5531, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { NorthDatasetImportMaterializationWorker } = await import("../src/modules/north/data/import-materialization-worker.js");
  const { StreamingDatasetImportMaterializer } = await import("../src/modules/north/data/import-materialization-parser.js");
  const scratch = mkdtempSync(join(tmpdir(), "analytics-contracts-"));
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); rmSync(scratch, { recursive: true, force: true }); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PATCH" | "PUT";
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

  await t.test("organization brand colors validate, persist and uppercase", async () => {
    const updated = expectStatus(await call("PATCH", `/v1/organizations/${org}`, owner.cookie, { brandPrimary: "#1b3a7a", brandAccent: "#2f6fed" }), 200);
    assert.deepEqual([updated.brandPrimary, updated.brandAccent], ["#1B3A7A", "#2F6FED"]);
    assert.equal((await call("PATCH", `/v1/organizations/${org}`, owner.cookie, { brandAccent: "blue; background:url(x)" })).statusCode, 400);
    expectStatus(await call("PATCH", `/v1/organizations/${org}`, owner.cookie, { brandAccent: null }), 200);
    assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: org } })).brandAccent, null);
    expectStatus(await call("PATCH", `/v1/organizations/${org}`, owner.cookie, { brandAccent: "#2F6FED" }), 200);
  });

  // --- a real dataset through the production worker: 12,000 rows, closed-form expectations ---
  const rowsExpected = 12_000;
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

  // --- panel + bindings ---
  const category = expectStatus(await call("POST", `/v1/organizations/${org}/categories`, owner.cookie, { name: { en: "Analytics" }, slug: "analytics" }), 201);
  const subcategory = expectStatus(await call("POST", `/v1/organizations/${org}/categories/${category.id}/subcategories`, owner.cookie, { name: { en: "Overview" }, slug: "overview" }), 201);
  const panel = expectStatus(await call("POST", `/v1/organizations/${org}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { en: "Dashboard" }, slug: "dashboard" }), 201);
  const filters = [{ fieldId: consignee, operators: ["IN", "EQ"] }, { fieldId: day, operators: ["GTE", "LTE"] }];
  const makeBinding = async (name: string, query: unknown, allowedFilters = filters) =>
    expectStatus(await call("POST", `/v1/organizations/${org}/panels/${panel.id}/analytics-bindings`, owner.cookie, { name, datasetId: dataset.id, query, allowedFilters }), 201).id as string;
  const countByDay = await makeBinding("count", { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }], compareBy: day });
  const grid = await makeBinding("grid", { mode: "AGGREGATE", groupBy: [consignee], measures: [{ operation: "COUNT", alias: "n" }, { operation: "SUM", fieldId: weight, alias: "kg" }], orderBy: [{ key: "n", direction: "DESC" }], limit: 50, includeTotal: true, searchFieldIds: [consignee] });
  const monthly = await makeBinding("monthly", { mode: "AGGREGATE", groupBy: [day], granularity: { [day]: "MONTH" }, measures: [{ operation: "COUNT", alias: "n" }], orderBy: [{ key: day, direction: "ASC" }], limit: 100 });
  assert.equal((await call("POST", `/v1/organizations/${org}/panels/${panel.id}/analytics-bindings`, owner.cookie, { name: "bad", datasetId: dataset.id, query: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }], compareBy: consignee }, allowedFilters: filters })).statusCode, 422, "compareBy must be an allowed date field");
  assert.equal((await call("POST", `/v1/organizations/${org}/panels/${panel.id}/analytics-bindings`, owner.cookie, { name: "bad2", datasetId: dataset.id, query: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }], searchFieldIds: [weight] }, allowedFilters: filters })).statusCode, 422, "search fields must be text");

  const ref = (bindingId: string) => ({ sourceType: "dataset", sourceId: bindingId, datasetId: dataset.id });
  const cell = { x: 0, y: 0, w: 4, h: 3 };
  const documentOf = (components: unknown[]) => ({ schemaVersion: 1, defaultLocale: "en", fallbackLocales: [], sections: [{ id: "s1", order: 0, layout: { variant: "grid", gap: "md" }, components }] });
  const component = (idValue: string, type: string, props: unknown, bindings: unknown, order: number) => ({ id: idValue, type, schemaVersion: 1, props, bindings, order, layout: { desktop: { ...cell, y: order * 3 }, tablet: { ...cell, y: order * 3 }, mobile: { ...cell, w: 12, y: order * 3 } } });
  const draft = expectStatus(await call("PATCH", `/v1/organizations/${org}/panels/${panel.id}/draft`, owner.cookie, { document: documentOf([
    component("k", "kpi_card", { label: { en: "Rows" }, valueKey: "n", format: "number", icon: "container", tone: "blue", variant: "trend", comparison: {} }, { data: ref(countByDay) }, 0),
    component("g", "data_grid", { title: { en: "Results" }, columns: [{ key: consignee, label: { en: "Consignee" }, kind: "text" }, { key: "n", label: { en: "Rows" }, kind: "bar" }], pageSizes: [10, 20], defaultPageSize: 10 }, { data: ref(grid) }, 1),
    component("f", "filter_bar", { title: { en: "Filters" } }, {}, 2),
    component("c", "line_chart", { categoryKey: day, series: [{ key: "n", label: { en: "Rows" } }] }, { data: ref(monthly) }, 3),
    component("d", "donut_chart", { categoryKey: consignee, valueKey: "n", totalKey: "n", maxSlices: 5, legend: "right" }, { data: ref(grid), total: ref(countByDay) }, 4),
    component("i", "insights", { items: [{ id: "x", rule: "period_change", binding: "change", valueKey: "n", title: { en: "Change" } }] }, { change: ref(countByDay) }, 5),
  ]) }), 200);
  const report = expectStatus(await call("POST", `/v1/organizations/${org}/panels/${panel.id}/draft/validate`, owner.cookie), 200);
  assert.deepEqual(report.issues.filter((issue: { severity: string }) => issue.severity === "error"), [], "the new components validate against multi-binding outputs");
  expectStatus(await call("POST", `/v1/organizations/${org}/panels/${panel.id}/publish`, owner.cookie, undefined, { "if-match": report.etag ?? draft.etag }), 200);

  const results = (bindingId: string, body: unknown, cookie = owner.cookie, organization = org) => call("POST", `/v1/organizations/${organization}/panels/${panel.id}/analytics-bindings/${bindingId}/results`, cookie, body);

  await t.test("results: stable paging, runtime sort/search on declared outputs, and totals", async () => {
    const first = expectStatus(await results(grid, { filters: [], offset: 0, limit: 10 }), 200);
    assert.equal(first.totalRows, 1000);
    assert.equal(first.rowCount, 10);
    const second = expectStatus(await results(grid, { filters: [], offset: 10, limit: 10 }), 200);
    assert.equal(new Set([...first.rows, ...second.rows].map((row: Record<string, string>) => row[consignee])).size, 20, "pages never overlap");
    const sorted = expectStatus(await results(grid, { filters: [], sort: { key: "kg", direction: "DESC" }, limit: 5 }), 200);
    const kilos = sorted.rows.map((row: Record<string, string>) => Number(row.kg));
    assert.deepEqual(kilos, [...kilos].sort((a, b) => b - a));
    assert.equal((await results(grid, { filters: [], sort: { key: weight, direction: "ASC" } })).statusCode, 422, "only the binding's own outputs may be sorted");
    const searched = expectStatus(await results(grid, { filters: [], search: "consignee 99", limit: 50 }), 200);
    assert.equal(searched.totalRows, 11);
    assert.equal((await results(countByDay, { filters: [], search: "x" })).statusCode, 422, "a binding without searchFieldIds rejects search");
    assert.equal(expectStatus(await results(grid, { filters: [], limit: 1_000 }), 200).rowCount, 50, "a reader can only shrink the page");
  });

  await t.test("results: previous-period comparison is computed by CORECROW from the selected month", async () => {
    const february = [{ fieldId: day, operator: "GTE", value: "2024-02-01" }, { fieldId: day, operator: "LTE", value: "2024-02-29" }];
    const current = expectStatus(await results(countByDay, { filters: february, compare: true }), 200);
    assert.equal(current.rows[0].n, "406", "29 days x 14 occurrences");
    assert.deepEqual(current.comparison.previousPeriod, { from: "2024-01-01", to: "2024-02-01" });
    assert.equal(current.comparison.rows[0].n, "434", "31 days x 14 occurrences");
    const open = expectStatus(await results(countByDay, { filters: [{ fieldId: day, operator: "GTE", value: "2024-02-01" }], compare: true }), 200);
    assert.equal(open.comparison, undefined, "an open-ended range has no comparable period");
    const none = expectStatus(await results(countByDay, { filters: [], compare: true }), 200);
    assert.equal(none.comparison, undefined);
    const again = expectStatus(await results(countByDay, { filters: february, compare: true }), 200);
    assert.equal(again.rows[0].n, "406", "a cached repeat returns the same figures");
    assert.equal(expectStatus(await results(countByDay, { filters: february, compare: true, fresh: true }), 200).rows[0].n, "406");
  });

  await t.test("facets: search, paging, counts and date buckets serialize correctly", async () => {
    const facets = (body: unknown, cookie = owner.cookie) => call("POST", `/v1/organizations/${org}/panels/${panel.id}/analytics-bindings/${grid}/facets`, cookie, body);
    const page = expectStatus(await facets({ fieldId: consignee, limit: 20 }), 200);
    assert.equal(page.values.length, 20);
    assert.equal(page.total, 1000);
    assert.equal(page.truncated, true);
    const next = expectStatus(await facets({ fieldId: consignee, limit: 20, offset: 20 }), 200);
    assert.equal(new Set([...page.values, ...next.values].map((value: { value: string }) => value.value)).size, 40);
    const searched = expectStatus(await facets({ fieldId: consignee, search: "consignee 99", limit: 50 }), 200);
    assert.equal(searched.total, 11);
    assert.equal(searched.truncated, false);
    const months = expectStatus(await facets({ fieldId: day, granularity: "MONTH", limit: 100 }), 200);
    assert.equal(months.values.length, 30, "900 days span 30 calendar months");
    assert.ok(months.values[0].value > months.values.at(-1).value, "newest month first");
    assert.equal((await facets({ fieldId: weight, limit: 5 })).statusCode, 422, "facets only exist for allowed filter fields");
  });

  await t.test("tenant isolation: another organization's member cannot read bindings or facets", async () => {
    assert.equal((await results(grid, { filters: [] }, outsider.cookie)).statusCode, 404);
    assert.equal((await call("POST", `/v1/organizations/${org}/panels/${panel.id}/analytics-bindings/${grid}/facets`, outsider.cookie, { fieldId: consignee })).statusCode, 404);
    assert.equal((await results(grid, { filters: [] }, outsider.cookie, otherOrg)).statusCode, 404, "cross-tenant URL mixing is refused");
    assert.equal((await results(grid, { filters: [] }, "")).statusCode, 401);
  });
});
