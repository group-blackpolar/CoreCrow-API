import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

test("conditional measures (when) and MONTH_OF_YEAR: one column per year, NULL where a year has no rows, exact against a closed form", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5538?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";
  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5538, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { NorthDatasetImportMaterializationWorker } = await import("../src/modules/north/data/import-materialization-worker.js");
  const { StreamingDatasetImportMaterializer } = await import("../src/modules/north/data/import-materialization-parser.js");
  const scratch = mkdtempSync(join(tmpdir(), "conditional-"));
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { rmSync(scratch, { recursive: true, force: true }); await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  let n = 1;
  const call = (method: "GET" | "POST", url: string, cookie?: string, payload?: unknown) => app.inject({ method, url, remoteAddress: `127.0.130.${n++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const ok = (response: Awaited<ReturnType<typeof call>>, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  const email = `${randomUUID().slice(0, 8)}-cond@blackpolar.test`;
  ok(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: "127.0.131.5", headers: { origin: "http://localhost:3000" }, payload: { email, password: "Test-password-only-123!", name: "cond" } }), 200);
  ok(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code: messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1] }), 200);
  const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: "127.0.132.6", headers: { origin: "http://localhost:3000" }, payload: { email, password: "Test-password-only-123!" } });
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const org = ok(await call("POST", "/v1/organizations", cookie, { name: `Cond ${randomUUID().slice(0, 6)}` }), 201).id as string;
  const dataset = ok(await call("POST", `/v1/organizations/${org}/datasets`, cookie, { name: { en: "Cond" }, slug: "cond" }), 201).id as string;
  const rows = 1000;
  const file = await writeXlsx(scratch, "c.xlsx", baseParts({ sheetXml: generatedSheet(rows) }));
  const membership = await prisma.membership.findFirstOrThrow({ where: { organizationId: org } });
  const job = await prisma.northDatasetImportJob.create({ data: { organizationId: org, datasetId: dataset, requestedBy: membership.userId, requestedMembershipId: membership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(), requestHash: createHash("sha256").update("c").digest("hex"), filename: "c.xlsx", declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n, declaredChecksum: "d".repeat(64), storageKey: `opaque/${randomUUID()}`, storageVersionId: "v1", status: "AWAITING_MAPPING", scanStatus: "APPROVED", confirmedAt: new Date() } });
  const map = await prisma.northDatasetImportMappingVersion.create({ data: { organizationId: org, datasetId: dataset, importId: job.id, version: 1, sheetOrdinal: 0, headerRow: 1, createdBy: membership.userId, definition: { duplicates: "KEEP", columns: [
    { sourceOrdinal: 0, action: "CREATE", key: "day", displayName: { en: "Day" }, canonicalType: "DATE", nullable: false },
    { sourceOrdinal: 1, action: "CREATE", key: "consignee", displayName: { en: "Consignee" }, canonicalType: "TEXT", nullable: false },
    { sourceOrdinal: 2, action: "CREATE", key: "weight", displayName: { en: "Weight" }, canonicalType: "DECIMAL", nullable: false },
  ] } as never } });
  ok(await call("POST", `/v1/organizations/${org}/datasets/${dataset}/imports/${job.id}/activate`, cookie, { mappingId: map.id, mode: "REPLACE_DATASET" }), 202);
  const worker = new NorthDatasetImportMaterializationWorker("cond", new StreamingDatasetImportMaterializer({ async openPrivateRead() { return createReadStream(file); } } as never), { leaseMilliseconds: 300_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 1_000 });
  for (let i = 0; i < 10 && (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: job.id } })).status === "READY_TO_ACTIVATE"; i += 1) await worker.runOnce();
  const fields = ok(await call("GET", `/v1/organizations/${org}/datasets/${dataset}/fields`, cookie), 200) as Array<{ id: string; key: string }>;
  const day = fields.find((f) => f.key === "day")!.id;
  const query = (body: object) => call("POST", `/v1/organizations/${org}/datasets/${dataset}/query`, cookie, body);

  // Closed form: row i has date 2024-01-01 + (i % 900) days.
  const expected = new Map<string, number>();
  for (let i = 0; i < rows; i += 1) { const d = new Date(Date.UTC(2024, 0, 1 + (i % 900))); const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`; expected.set(key, (expected.get(key) ?? 0) + 1); }
  const year = (y: number) => ({ operation: "COUNT", alias: `y${y}`, when: [{ fieldId: day, operator: "GTE", value: `${y}-01-01` }, { fieldId: day, operator: "LTE", value: `${y}-12-31` }] });

  const byMonth = ok(await query({ mode: "AGGREGATE", groupBy: [day], granularity: { [day]: "MONTH_OF_YEAR" }, measures: [year(2024), year(2025), year(2026), { operation: "COUNT", alias: "all" }], orderBy: [{ key: day, direction: "ASC" }], limit: 12 }), 200);
  assert.equal(byMonth.columns[0].type, "INTEGER");
  assert.equal(byMonth.rows.length, 12);
  for (const row of byMonth.rows) {
    const m = Number(row[day]);
    for (const y of [2024, 2025, 2026]) {
      const want = expected.get(`${y}-${m}`);
      const got = row[`y${y}`];
      assert.equal(got === null ? null : Number(got), want ?? null, `month ${m} year ${y}`);
    }
    assert.equal(Number(row.all), [2024, 2025, 2026].reduce((sum, y) => sum + (expected.get(`${y}-${m}`) ?? 0), 0));
  }
  assert.equal(byMonth.rows.find((r: Record<string, unknown>) => Number(r[day]) === 12)!.y2026, null, "a year without rows in that month is NULL, not 0");

  // The query filters still narrow every measure; `when` narrows only its own.
  const narrowed = ok(await query({ mode: "AGGREGATE", measures: [year(2025), { operation: "COUNT", alias: "all" }], filters: [{ fieldId: day, operator: "GTE", value: "2025-06-01" }] }), 200);
  const from = [...expected].filter(([k]) => { const [y, m] = k.split("-").map(Number); return y! > 2025 || (y === 2025 && m! >= 6); });
  assert.equal(Number(narrowed.rows[0].all), from.reduce((sum, [, c]) => sum + c, 0));

  // Refusals: unknown field in `when`, and `when` together with distinctBy.
  assert.equal((await query({ mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "x", when: [{ fieldId: "nope", operator: "EQ", value: "a" }] }] })).json().error.code, "DATASET_QUERY_FIELD_INVALID");
  assert.equal((await query({ mode: "AGGREGATE", measures: [{ operation: "SUM", fieldId: fields.find((f) => f.key === "weight")!.id, distinctBy: day, alias: "x", when: [{ fieldId: day, operator: "GTE", value: "2024-01-01" }] }] })).statusCode, 400);
});
