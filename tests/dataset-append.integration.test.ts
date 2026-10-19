import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

test("incremental APPEND imports: duplicate file, period overlap, history kept, atomic revisions", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5534?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5534, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { NorthDatasetImportMaterializationWorker } = await import("../src/modules/north/data/import-materialization-worker.js");
  const { StreamingDatasetImportMaterializer } = await import("../src/modules/north/data/import-materialization-parser.js");
  const scratch = mkdtempSync(join(tmpdir(), "append-"));
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { rmSync(scratch, { recursive: true, force: true }); await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.70.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const expectStatus = (response: Res, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  const cookieOf = (response: Res) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const email = `${prefix}-owner@blackpolar.test`;
  expectStatus(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: "127.0.71.10", headers: { origin: "http://localhost:3000" }, payload: { email, password, name: "owner" } }), 200);
  const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
  assert.ok(code);
  expectStatus(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
  const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: "127.0.72.11", headers: { origin: "http://localhost:3000" }, payload: { email, password } });
  expectStatus(login, 200);
  const owner = { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, cookie: cookieOf(login) };

  const org = expectStatus(await call("POST", "/v1/organizations", owner.cookie, { name: `Append ${prefix}` }), 201).id as string;
  const base = `/v1/organizations/${org}`;
  const membership = await prisma.membership.findFirstOrThrow({ where: { organizationId: org, userId: owner.id } });
  const group = expectStatus(await call("POST", `${base}/dataset-groups`, owner.cookie, { slug: "local-import", name: { en: "Local Import" } }), 201);
  const dataset = expectStatus(await call("POST", `${base}/datasets`, owner.cookie, { name: { en: "Local" }, slug: "local-2026" }), 201).id as string;
  const sibling = expectStatus(await call("POST", `${base}/datasets`, owner.cookie, { name: { en: "Sibling" }, slug: "sibling" }), 201).id as string;
  expectStatus(await call("PUT", `${base}/datasets/${dataset}/group`, owner.cookie, { groupId: group.id, periodStart: "2026-01-01", periodEnd: "2026-04-30" }), 200);
  expectStatus(await call("PUT", `${base}/datasets/${sibling}/group`, owner.cookie, { groupId: group.id, periodStart: "2026-07-01", periodEnd: "2026-07-31" }), 200);

  let n = 0;
  const files = new Map<string, string>();
  const prepare = async (rows: number, checksumChar: string, mapping: "create" | "map") => {
    const file = await writeXlsx(scratch, `f${n++}.xlsx`, baseParts({ sheetXml: generatedSheet(rows) }));
    const job = await prisma.northDatasetImportJob.create({ data: {
      organizationId: org, datasetId: dataset, requestedBy: owner.id, requestedMembershipId: membership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(),
      requestHash: createHash("sha256").update(file).digest("hex"), filename: `f${n}.xlsx`, declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n,
      declaredChecksum: checksumChar.repeat(64), storageKey: `opaque/${prefix}-${n}`, storageVersionId: "v1", status: "AWAITING_MAPPING", scanStatus: "APPROVED", confirmedAt: new Date(),
    } });
    files.set(job.id, file);
    const columns = mapping === "create"
      ? [
          { sourceOrdinal: 0, action: "CREATE", key: "day", displayName: { en: "Day" }, canonicalType: "DATE", nullable: false },
          { sourceOrdinal: 1, action: "CREATE", key: "consignee", displayName: { en: "Consignee" }, canonicalType: "TEXT", nullable: false },
          { sourceOrdinal: 2, action: "CREATE", key: "weight", displayName: { en: "Weight" }, canonicalType: "DECIMAL", nullable: false },
        ]
      : (await prisma.northDatasetField.findMany({ where: { datasetId: dataset }, orderBy: { createdAt: "asc" } })).map((field, index) => ({ sourceOrdinal: index, action: "MAP", fieldId: field.id }));
    const map = await prisma.northDatasetImportMappingVersion.create({ data: { organizationId: org, datasetId: dataset, importId: job.id, version: 1, sheetOrdinal: 0, headerRow: 1, createdBy: owner.id, definition: { duplicates: "KEEP", columns } as never } });
    return { job, map };
  };
  type Prepared = Awaited<ReturnType<typeof prepare>>;
  const activate = (p: Prepared, body: object) => call("POST", `${base}/datasets/${dataset}/imports/${p.job.id}/activate`, owner.cookie, { mappingId: p.map.id, ...body });
  const run = async (p: Prepared) => {
    const worker = new NorthDatasetImportMaterializationWorker("append", new StreamingDatasetImportMaterializer({ async openPrivateRead() { return createReadStream(files.get(p.job.id)!); } } as never), { leaseMilliseconds: 300_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 1_000 });
    for (let i = 0; i < 10 && (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: p.job.id } })).status === "READY_TO_ACTIVATE"; i += 1) await worker.runOnce();
    return (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: p.job.id } })).status;
  };
  const count = async () => Number(expectStatus(await call("POST", `${base}/datasets/${dataset}/query`, owner.cookie, { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "rows" }] }), 200).rows[0].rows);

  // APPEND needs the covered period (contract-level validation).
  const first = await prepare(200, "a", "create");
  assert.equal((await activate(first, { mode: "APPEND" })).statusCode, 400);
  expectStatus(await activate(first, { mode: "APPEND", periodStart: "2026-01-01", periodEnd: "2026-04-30" }), 202);
  assert.equal(await run(first), "SUCCEEDED");
  assert.equal(await count(), 200);

  // May is added without touching January-April.
  const may = await prepare(50, "b", "map");
  expectStatus(await activate(may, { mode: "APPEND", periodStart: "2026-05-01", periodEnd: "2026-05-31" }), 202);
  assert.equal(await run(may), "SUCCEEDED");
  assert.equal(await count(), 250);
  const revisions = await prisma.northDatasetRevision.findMany({ where: { datasetId: dataset }, orderBy: { version: "asc" }, include: { batches: true } });
  assert.deepEqual(revisions.map((r) => [r.mode, r.rowCount, r.batches.length]), [["APPEND", 200, 1], ["APPEND", 250, 2]]);
  const current = await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset } });
  assert.equal(current.periodStart!.toISOString().slice(0, 10), "2026-01-01");
  assert.equal(current.periodEnd!.toISOString().slice(0, 10), "2026-05-31");

  // Same bytes again, an overlapping period and a collision with a sibling dataset are refused; nothing is queued.
  const again = await prepare(50, "b", "map");
  assert.equal((await activate(again, { mode: "APPEND", periodStart: "2026-06-01", periodEnd: "2026-06-30" })).json().error.code, "IMPORT_DUPLICATE_FILE");
  const overlap = await prepare(10, "c", "map");
  assert.equal((await activate(overlap, { mode: "APPEND", periodStart: "2026-05-15", periodEnd: "2026-06-15" })).json().error.code, "IMPORT_PERIOD_OVERLAP");
  const collide = await prepare(10, "d", "map");
  assert.equal((await activate(collide, { mode: "APPEND", periodStart: "2026-06-01", periodEnd: "2026-07-15" })).json().error.code, "IMPORT_PERIOD_OVERLAP");
  for (const refused of [again, overlap, collide]) assert.equal((await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: refused.job.id } })).status, "AWAITING_MAPPING");
  assert.equal(await count(), 250);

  // June goes through; earlier revisions stay untouched.
  const june = await prepare(30, "e", "map");
  expectStatus(await activate(june, { mode: "APPEND", periodStart: "2026-06-01", periodEnd: "2026-06-30" }), 202);
  assert.equal(await run(june), "SUCCEEDED");
  assert.equal(await count(), 280);
  assert.deepEqual((await prisma.northDatasetRevision.findMany({ where: { datasetId: dataset }, orderBy: { version: "asc" } })).map((r) => r.rowCount), [200, 250, 280]);
  assert.equal(await prisma.northDatasetRow.count({ where: { datasetId: dataset } }), 280);

  // REPLACE_DATASET still replaces.
  const replace = await prepare(20, "f", "map");
  expectStatus(await activate(replace, { mode: "REPLACE_DATASET" }), 202);
  assert.equal(await run(replace), "SUCCEEDED");
  assert.equal(await count(), 20);
  assert.ok(await prisma.auditLog.count({ where: { organizationId: org, action: "NORTH_DATASET_REVISION_ACTIVATED" } }) >= 4);
});
