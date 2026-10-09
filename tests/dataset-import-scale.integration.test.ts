import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

// Needs an isolated, migrated PostgreSQL database:
//   TEST_DATABASE_URL=postgresql://.../xxx_test pnpm exec tsx --test tests/dataset-import-scale.integration.test.ts
// Optional: SHARK_XLSX_FIXTURE=<path to a real workbook whose first sheet has the 26 Master/House columns> uses it instead of the generated one.
test("streamed import of ~183k rows is atomic, idempotent and bounded in memory", { skip: !process.env.TEST_DATABASE_URL, timeout: 900_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { prisma } = await import("../src/lib/database.js");
  const { NorthDatasetImportMaterializationWorker } = await import("../src/modules/north/data/import-materialization-worker.js");
  const { StreamingDatasetImportMaterializer } = await import("../src/modules/north/data/import-materialization-parser.js");
  const scratch = mkdtempSync(join(tmpdir(), "dataset-scale-"));
  t.after(async () => { await prisma.$disconnect(); rmSync(scratch, { recursive: true, force: true }); });

  const real = process.env.SHARK_XLSX_FIXTURE && existsSync(process.env.SHARK_XLSX_FIXTURE) ? process.env.SHARK_XLSX_FIXTURE : undefined;
  const expectedRows = real ? 192_799 : 183_040;
  const file = real ?? await writeXlsx(scratch, "scale.xlsx", baseParts({ sheetXml: generatedSheet(expectedRows) }));
  const columns = real
    ? Array.from({ length: 26 }, (_, i) => ({ sourceOrdinal: i, action: "CREATE", key: `column_${i}`, displayName: { en: `Column ${i}` }, canonicalType: i === 0 ? "DATE" : [3, 8, 13, 16, 21, 25].includes(i) ? "DECIMAL" : "TEXT", nullable: true }))
    : [
      { sourceOrdinal: 0, action: "CREATE", key: "day", displayName: { en: "Day" }, canonicalType: "DATE", nullable: false },
      { sourceOrdinal: 1, action: "CREATE", key: "consignee", displayName: { en: "Consignee" }, canonicalType: "TEXT", nullable: false },
      { sourceOrdinal: 2, action: "CREATE", key: "weight", displayName: { en: "Weight" }, canonicalType: "DECIMAL", nullable: false },
    ];

  const prefix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { email: `${prefix}-scale@blackpolar.test`, emailVerified: true } });
  const organization = await prisma.organization.create({ data: { name: `Scale ${prefix}`, slug: `scale-${prefix}` } });
  const membership = await prisma.membership.create({ data: { organizationId: organization.id, userId: user.id, role: "OWNER" } });
  const dataset = await prisma.northDataset.create({ data: { organizationId: organization.id, name: { en: "Scale" }, slug: "scale", createdBy: user.id } });
  const makeJob = async (label: string, definition: unknown[]) => {
    const job = await prisma.northDatasetImportJob.create({
      data: {
        organizationId: organization.id, datasetId: dataset.id, requestedBy: user.id, requestedMembershipId: membership.id,
        idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(), requestHash: createHash("sha256").update(label).digest("hex"), filename: "scale.xlsx",
        declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n, declaredChecksum: "a".repeat(64),
        storageKey: `opaque/${prefix}/${label}`, storageVersionId: "v1", status: "READY_TO_ACTIVATE", scanStatus: "APPROVED", confirmedAt: new Date(),
      },
    });
    const mapping = await prisma.northDatasetImportMappingVersion.create({
      data: { organizationId: organization.id, datasetId: dataset.id, importId: job.id, version: 1, sheetOrdinal: 0, headerRow: 1, definition: { columns: definition } as never, createdBy: user.id },
    });
    await prisma.northDatasetImportJob.update({ where: { id: job.id }, data: { activationMappingId: mapping.id, activationRequestedBy: user.id } });
    return job;
  };
  const storage = { async openPrivateRead() { return createReadStream(file); } } as never;
  const worker = new NorthDatasetImportMaterializationWorker(`scale-${prefix}`, new StreamingDatasetImportMaterializer(storage), {
    leaseMilliseconds: 600_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 1_000,
  });
  const runUntil = async (jobId: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const outcome = await worker.runOnce();
      const job = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: jobId } });
      if (["SUCCEEDED", "FAILED"].includes(job.status)) return { outcome, job };
      if (outcome === "IDLE") break;
    }
    return { outcome: "IDLE", job: await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: jobId } }) };
  };

  // 1. a workbook that violates its mapping fails during the validating pass: nothing is written, nothing becomes active
  const bad = await makeJob("bad", columns.map((column, ordinal) => ({ ...column, canonicalType: ordinal === 1 ? "INTEGER" : column.canonicalType })));
  const failed = await runUntil(bad.id);
  assert.equal(failed.job.status, "FAILED");
  assert.equal(failed.job.lastErrorCode, "IMPORT_VALUE_TYPE_INVALID");
  assert.equal(await prisma.northDatasetImportBatch.count({ where: { datasetId: dataset.id } }), 0);
  assert.equal(await prisma.northDatasetRow.count({ where: { datasetId: dataset.id } }), 0);
  assert.equal((await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId, null);
  assert.equal(await prisma.northDatasetField.count({ where: { datasetId: dataset.id } }), 0, "fields of a failed import are not created");

  // 2. the real import, with parent memory sampled while rows stream into PostgreSQL
  const good = await makeJob("good", columns);
  let peakRss = 0;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  const started = Date.now();
  const succeeded = await runUntil(good.id).finally(() => clearInterval(sampler));
  const seconds = (Date.now() - started) / 1000;
  assert.equal(succeeded.job.status, "SUCCEEDED");
  const batch = await prisma.northDatasetImportBatch.findUniqueOrThrow({ where: { importId: good.id } });
  const rows = await prisma.northDatasetRow.count({ where: { datasetId: dataset.id, batchId: batch.id } });
  console.log(`# streamed import: ${rows} rows persisted in ${seconds.toFixed(1)}s (validate + stream + insert), parent peak RSS ${(peakRss / 1048576).toFixed(0)} MiB, parser ${batch.parserVersion}`);
  assert.equal(batch.rowCount, expectedRows);
  assert.equal(rows, expectedRows);
  assert.ok(peakRss < 1024 * 1048576, "worker process stays under 1 GiB while streaming");
  const dataset2 = await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } });
  assert.ok(dataset2.activeRevisionId);
  assert.equal((await prisma.northDatasetRevision.findUniqueOrThrow({ where: { id: dataset2.activeRevisionId! } })).rowCount, expectedRows);
  const ordinals = await prisma.$queryRaw<Array<{ min: number; max: number; distinct: bigint }>>`SELECT MIN("ordinal")::int AS min, MAX("ordinal")::int AS max, COUNT(DISTINCT "ordinal") AS distinct FROM "NorthDatasetRow" WHERE "batchId" = ${batch.id}`;
  assert.deepEqual([ordinals[0]!.min, ordinals[0]!.max, Number(ordinals[0]!.distinct)], [0, expectedRows - 1, expectedRows], "ordinals are contiguous and unique");

  // 3. re-running the worker is a no-op: one batch, same rows, same active revision
  assert.equal(await worker.runOnce(), "IDLE");
  assert.equal(await prisma.northDatasetImportBatch.count({ where: { datasetId: dataset.id } }), 1);
  assert.equal(await prisma.northDatasetRow.count({ where: { datasetId: dataset.id } }), expectedRows);
  assert.equal((await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId, dataset2.activeRevisionId);
});
