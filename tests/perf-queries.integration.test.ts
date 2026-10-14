import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

test("perf: dataset query latency (opt-in, prints a table)", { skip: !process.env.TEST_DATABASE_URL || !process.env.PERF, timeout: 300_000 }, async (t) => {
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

  const percentile = (values: number[], p: number) => { const sorted = [...values].sort((x, y) => x - y); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };
  const rowsOut: string[] = [];
  for (const size of [12_000, 120_000]) {
    const slug = `perf-${size}`;
    const dataset = expectStatus(await call("POST", `/v1/organizations/${org}/datasets`, owner.cookie, { name: { en: slug }, slug }), 201);
    const file = await writeXlsx(scratch, `${slug}.xlsx`, baseParts({ sheetXml: generatedSheet(size) }));
    const membership = await prisma.membership.findFirstOrThrow({ where: { organizationId: org, userId: owner.id } });
    const job = await prisma.northDatasetImportJob.create({ data: {
      organizationId: org, datasetId: dataset.id, requestedBy: owner.id, requestedMembershipId: membership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(),
      requestHash: createHash("sha256").update(slug).digest("hex"), filename: `${slug}.xlsx`, declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n,
      declaredChecksum: "a".repeat(64), storageKey: `opaque/${slug}`, storageVersionId: "v1", status: "READY_TO_ACTIVATE", scanStatus: "APPROVED", confirmedAt: new Date(),
    } });
    const mapping = await prisma.northDatasetImportMappingVersion.create({ data: { organizationId: org, datasetId: dataset.id, importId: job.id, version: 1, sheetOrdinal: 0, headerRow: 1, createdBy: owner.id, definition: { duplicates: "SKIP_EXACT", columns: [
      { sourceOrdinal: 0, action: "CREATE", key: "day", displayName: { en: "Day" }, canonicalType: "DATE", nullable: false },
      { sourceOrdinal: 1, action: "CREATE", key: "consignee", displayName: { en: "Consignee" }, canonicalType: "TEXT", nullable: false },
      { sourceOrdinal: 2, action: "CREATE", key: "weight", displayName: { en: "Weight" }, canonicalType: "DECIMAL", nullable: false },
    ] } as never } });
    await prisma.northDatasetImportJob.update({ where: { id: job.id }, data: { activationMappingId: mapping.id, activationRequestedBy: owner.id } });
    const worker = new NorthDatasetImportMaterializationWorker("perf", new StreamingDatasetImportMaterializer({ async openPrivateRead() { return createReadStream(file); } } as never), { leaseMilliseconds: 600_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 1_000 });
    const importStart = performance.now();
    for (let attempt = 0; attempt < 10 && (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: job.id } })).status !== "SUCCEEDED"; attempt += 1) await worker.runOnce();
    const importMs = performance.now() - importStart;
    const fields = expectStatus(await call("GET", `/v1/organizations/${org}/datasets/${dataset.id}/fields`, owner.cookie), 200) as Array<{ id: string; key: string }>;
    const id = (key: string) => fields.find((field) => field.key === key)!.id;
    const [day, consignee, weight] = [id("day"), id("consignee"), id("weight")];
    const queries: Record<string, unknown> = {
      "total (COUNT)": { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }] },
      "top 20 consignees (GROUP BY text, SUM)": { mode: "AGGREGATE", groupBy: [consignee], measures: [{ operation: "COUNT", alias: "n" }, { operation: "SUM", fieldId: weight, alias: "kg" }], orderBy: [{ key: "n", direction: "DESC" }], limit: 20 },
      "monthly series (GROUP BY month)": { mode: "AGGREGATE", groupBy: [day], granularity: { [day]: "MONTH" }, measures: [{ operation: "COUNT", alias: "n" }], orderBy: [{ key: day, direction: "ASC" }], limit: 100 },
      "filtered by consignee (IN) + SUM": { mode: "AGGREGATE", measures: [{ operation: "SUM", fieldId: weight, alias: "kg" }], filters: [{ fieldId: consignee, operator: "EQ", value: "CONSIGNEE 7 & CO" }] },
      "table page (50 rows, ordered)": { mode: "ROWS", fields: [day, consignee, weight], orderBy: [{ fieldId: day, direction: "DESC" }], limit: 50, includeTotal: true },
    };
    for (const [name, query] of Object.entries(queries)) {
      const times: number[] = [];
      let first = 0;
      for (let run = 0; run < 25; run += 1) {
        const start = performance.now();
        const response = await call("POST", `/v1/organizations/${org}/datasets/${dataset.id}/query`, owner.cookie, query);
        const elapsed = performance.now() - start;
        if (response.statusCode !== 200) throw new Error(`${name}: ${response.statusCode} ${response.body}`);
        if (run === 0) first = elapsed; else times.push(elapsed);
      }
      rowsOut.push(`| ${size.toLocaleString("en-US")} | ${name} | ${first.toFixed(0)} | ${percentile(times, 0.5).toFixed(0)} | ${percentile(times, 0.95).toFixed(0)} |`);
    }
    rowsOut.push(`| ${size.toLocaleString("en-US")} | import (stream + materialize) | ${importMs.toFixed(0)} | - | - |`);
  }
  console.log("PERF_TABLE\n| rows | query | first ms | p50 ms | p95 ms |\n|---|---|---|---|---|\n" + rowsOut.join("\n"));
});
