import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

test("dataset erase: dependencies, archive-first, tenant isolation, real data", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5532?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5532, "127.0.0.1", resolve));
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

  const org2 = org;
  const base = `/v1/organizations/${org}`;
  const counts = async () => ({
    rows: await prisma.northDatasetRow.count({ where: { datasetId: dataset.id } }),
    revisions: await prisma.northDatasetRevision.count({ where: { datasetId: dataset.id } }),
    jobs: await prisma.northDatasetImportJob.count({ where: { datasetId: dataset.id } }),
  });
  assert.ok((await counts()).rows > 0);

  await t.test("sync history purge: dry run, lineage is protected, failed jobs go, audit store untouched", async () => {
    const purge = (payload: unknown, cookie = owner.cookie) => call("POST", `${base}/datasets/${dataset.id}/imports/purge`, cookie, payload);
    const failed = await prisma.northDatasetImportJob.create({ data: {
      organizationId: org, datasetId: dataset.id, requestedBy: owner.id, requestedMembershipId: membership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(),
      requestHash: createHash("sha256").update("failed").digest("hex"), filename: "bad.xlsx", declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n,
      declaredChecksum: "b".repeat(64), storageKey: `opaque/failed-${prefix}`, status: "FAILED", scanStatus: "APPROVED",
    } });
    await prisma.northDatasetImportJob.update({ where: { id: failed.id }, data: { updatedAt: new Date(Date.now() - 40 * 86_400_000) } });
    const auditBefore = await prisma.auditLog.count({ where: { organizationId: org, action: { startsWith: "security." } } });
    assert.equal((await purge({ olderThanDays: 30, dryRun: true }, outsider.cookie)).statusCode >= 400, true);
    assert.deepEqual(expectStatus(await purge({ olderThanDays: 30 }), 200), { matched: 1, purged: 0, dryRun: true });
    assert.equal(await prisma.northDatasetImportJob.count({ where: { id: failed.id } }), 1);
    assert.deepEqual(expectStatus(await purge({ olderThanDays: 60, dryRun: false }), 200), { matched: 0, purged: 0, dryRun: false });
    assert.deepEqual(expectStatus(await purge({ olderThanDays: 30, dryRun: false }), 200), { matched: 1, purged: 1, dryRun: false });
    assert.equal(await prisma.northDatasetImportJob.count({ where: { id: failed.id } }), 0);
    // the succeeded job owns a batch (lineage of live data): never matched, even with olderThanDays = 0
    assert.equal(expectStatus(await purge({ olderThanDays: 0, dryRun: false }), 200).purged, 0);
    assert.equal(await prisma.northDatasetImportJob.count({ where: { id: job.id } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { organizationId: org, action: "NORTH_DATASET_IMPORTS_PURGED" } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { organizationId: org, action: { startsWith: "security." } } }), auditBefore);
  });
  await t.test("erase requires archive first", async () => {
    const r = await call("DELETE", `${base}/datasets/${dataset.id}`, owner.cookie);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error.code, "DATASET_NOT_ARCHIVED");
  });

  const category = expectStatus(await call("POST", `${base}/categories`, owner.cookie, { name: { en: "C" }, slug: "erase-cat" }), 201);
  const subcategory = expectStatus(await call("POST", `${base}/categories/${category.id}/subcategories`, owner.cookie, { name: { en: "S" }, slug: "erase-sub" }), 201);
  const panel = expectStatus(await call("POST", `${base}/subcategories/${subcategory.id}/panels`, owner.cookie, { name: { en: "P" }, slug: "erase-panel" }), 201);
  const created = await call("POST", `${base}/panels/${panel.id}/analytics-bindings`, owner.cookie, { name: "b", datasetId: dataset.id, query: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }] }, allowedFilters: [{ fieldId: day, operators: ["GTE"] }] });
  assert.equal(created.statusCode, 201, created.body);
  const bindingId = created.json().id as string;
  expectStatus(await call("PATCH", `${base}/datasets/${dataset.id}`, owner.cookie, { status: "ARCHIVED" }), 200);
  await t.test("an analytics binding blocks the erase and is reported", async () => {
    const deps = expectStatus(await call("GET", `${base}/datasets/${dataset.id}/dependencies`, owner.cookie), 200);
    assert.equal(deps.bindings, 1);
    const r = await call("DELETE", `${base}/datasets/${dataset.id}`, owner.cookie);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error.code, "DATASET_IN_USE");
    assert.equal(r.json().error.bindings, 1, r.body);
    assert.ok((await counts()).rows > 0);
  });
  await t.test("outsiders and non-managers cannot erase", async () => {
    assert.ok([403, 404].includes((await call("DELETE", `${base}/datasets/${dataset.id}`, outsider.cookie)).statusCode));
    assert.ok([403, 404].includes((await call("DELETE", `/v1/organizations/${otherOrg}/datasets/${dataset.id}`, outsider.cookie)).statusCode));
    assert.ok((await counts()).rows > 0);
  });
  await t.test("after unbinding, the erase removes every derived record and is not repeatable", async () => {
    // There is no per-binding delete route: removing the panel (permanent, audited) is what drops its bindings.
    expectStatus(await call("DELETE", `${base}/panels/${panel.id}`, owner.cookie), 200);
    const r = await call("DELETE", `${base}/datasets/${dataset.id}`, owner.cookie);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(await counts(), { rows: 0, revisions: 0, jobs: 0 });
    assert.equal(await prisma.northDataset.count({ where: { id: dataset.id } }), 0);
    assert.equal((await prisma.auditLog.count({ where: { action: "NORTH_DATASET_ERASED", targetId: dataset.id } })), 1);
    assert.equal((await call("DELETE", `${base}/datasets/${dataset.id}`, owner.cookie)).statusCode, 404);
    assert.equal((await call("GET", `${base}/datasets/${dataset.id}`, owner.cookie)).statusCode, 404);
  });
  await t.test("snapshot tables stay immutable outside an erase", async () => {
    const other = expectStatus(await call("POST", `${base}/datasets`, owner.cookie, { name: { en: "O" }, slug: "other-data" }), 201);
    await assert.rejects(prisma.northDatasetSchemaVersion.deleteMany({ where: { datasetId: other.id } }).then(() => prisma.$executeRaw`DELETE FROM "NorthDatasetRow" WHERE "datasetId" = ${other.id}`).then(() => { throw new Error("no rows to reject"); }), () => true);
  });
});
