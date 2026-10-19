import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

test("group queries merge member datasets; pipeline scripts are versioned, permissioned and never executed", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
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
  const { configurePipelineRunner, DisabledPipelineRunner } = await import("../src/modules/north/data/pipeline-runner.js");
  const scratch = mkdtempSync(join(tmpdir(), "group-query-"));
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { configurePipelineRunner(new DisabledPipelineRunner()); rmSync(scratch, { recursive: true, force: true }); await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.80.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const expectStatus = (response: Res, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  const cookieOf = (response: Res) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  let signup = 10;
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    expectStatus(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: `127.0.81.${signup++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expectStatus(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.82.${signup++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password } });
    expectStatus(login, 200);
    return { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, cookie: cookieOf(login) };
  }

  const owner = await account("owner");
  const member = await account("member");
  const outsider = await account("outsider");
  const org = expectStatus(await call("POST", "/v1/organizations", owner.cookie, { name: `GQ ${prefix}` }), 201).id as string;
  await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` });
  const base = `/v1/organizations/${org}`;
  const invite = expectStatus(await call("POST", `${base}/invitations`, owner.cookie, { kind: "CODE", role: "MEMBER" }), 201);
  expectStatus(await call("POST", "/v1/invitations/accept", member.cookie, { token: invite.token }), 200);
  const ownerMembership = await prisma.membership.findFirstOrThrow({ where: { organizationId: org, userId: owner.id } });
  const group = expectStatus(await call("POST", `${base}/dataset-groups`, owner.cookie, { slug: "local-import", name: { en: "Local Import" } }), 201);
  const gBase = `${base}/dataset-groups/${group.id}`;

  // --- three periods with closed-form contents: 40 rows, 24 rows, and one with a renamed weight column ---
  const makeDataset = async (slug: string, rows: number, period: [string, string], weightKey: string) => {
    const id = expectStatus(await call("POST", `${base}/datasets`, owner.cookie, { name: { en: slug }, slug }), 201).id as string;
    expectStatus(await call("PUT", `${base}/datasets/${id}/group`, owner.cookie, { groupId: group.id, periodStart: period[0], periodEnd: period[1] }), 200);
    const file = await writeXlsx(scratch, `${slug}.xlsx`, baseParts({ sheetXml: generatedSheet(rows) }));
    const job = await prisma.northDatasetImportJob.create({ data: {
      organizationId: org, datasetId: id, requestedBy: owner.id, requestedMembershipId: ownerMembership.id, idempotencyOperation: "DATASET_IMPORT_PREPARE", idempotencyKey: randomUUID(),
      requestHash: createHash("sha256").update(slug).digest("hex"), filename: `${slug}.xlsx`, declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", declaredSize: 1n,
      declaredChecksum: createHash("sha256").update(slug).digest("hex"), storageKey: `opaque/${prefix}-${slug}`, storageVersionId: "v1", status: "AWAITING_MAPPING", scanStatus: "APPROVED", confirmedAt: new Date(),
    } });
    const map = await prisma.northDatasetImportMappingVersion.create({ data: { organizationId: org, datasetId: id, importId: job.id, version: 1, sheetOrdinal: 0, headerRow: 1, createdBy: owner.id, definition: { duplicates: "KEEP", columns: [
      { sourceOrdinal: 0, action: "CREATE", key: "day", displayName: { en: "Day" }, canonicalType: "DATE", nullable: false },
      { sourceOrdinal: 1, action: "CREATE", key: "consignee", displayName: { en: "Consignee" }, canonicalType: "TEXT", nullable: false },
      { sourceOrdinal: 2, action: "CREATE", key: weightKey, displayName: { en: "Weight" }, canonicalType: "DECIMAL", nullable: false },
    ] } as never } });
    expectStatus(await call("POST", `${base}/datasets/${id}/imports/${job.id}/activate`, owner.cookie, { mappingId: map.id, mode: "REPLACE_DATASET" }), 202);
    const worker = new NorthDatasetImportMaterializationWorker("gq", new StreamingDatasetImportMaterializer({ async openPrivateRead() { return createReadStream(file); } } as never), { leaseMilliseconds: 300_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 1_000 });
    for (let i = 0; i < 10 && (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: job.id } })).status === "READY_TO_ACTIVATE"; i += 1) await worker.runOnce();
    assert.equal((await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: job.id } })).status, "SUCCEEDED");
    return id;
  };
  const a = await makeDataset("jan-apr", 40, ["2026-01-01", "2026-04-30"], "weight");
  const b = await makeDataset("may", 24, ["2026-05-01", "2026-05-31"], "weight");
  const c = await makeDataset("june-renamed", 10, ["2026-06-01", "2026-06-30"], "weight_kg");

  const query = (body: object, cookie = owner.cookie) => call("POST", `${gBase}/query`, cookie, body);
  const total = { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "rows" }, { operation: "SUM", fieldId: "weight", alias: "kg" }, { operation: "AVG", fieldId: "weight", alias: "avg_kg" }, { operation: "MIN", fieldId: "weight", alias: "lo" }, { operation: "MAX", fieldId: "weight", alias: "hi" }] };

  // The renamed dataset lacks `weight`: it is skipped and reported, never silently mixed in.
  const all = expectStatus(await query({ query: total }), 200);
  assert.deepEqual(all.datasets.map((d: { slug: string }) => d.slug), ["jan-apr", "may"]);
  assert.deepEqual(all.skipped.map((d: { reason: string }) => d.reason), ["MISSING_FIELD:weight"]);
  const row = all.rows[0];
  assert.equal(Number(row.rows), 64);
  assert.equal(Number(row.kg), 132); // 40*39/16 + 24*23/16
  assert.equal(Number(row.avg_kg), 132 / 64);
  assert.equal(Number(row.lo), 0);
  assert.equal(Number(row.hi), 39 / 8);

  // Grouping merges equal keys across datasets (consignee 0..9 exist in all three, 10..23 in two) and orders after the merge.
  const grouped = expectStatus(await query({ query: { mode: "AGGREGATE", groupBy: ["consignee"], measures: [{ operation: "COUNT", alias: "rows" }], orderBy: [{ key: "rows", direction: "DESC" }], limit: 100, includeTotal: true } }), 200);
  assert.equal(grouped.totalRows, 40);
  assert.equal(Number(grouped.rows[0].rows), 3);
  assert.equal(grouped.rows.filter((r: { rows: string }) => Number(r.rows) === 3).length, 10);
  assert.equal(grouped.rows.filter((r: { rows: string }) => Number(r.rows) === 2).length, 14);

  // Period pruning picks datasets by declared period; a single dataset supports the full engine (ROWS, distinct).
  const may = expectStatus(await query({ query: total, periodFrom: "2026-05-01", periodTo: "2026-05-31" }), 200);
  assert.deepEqual(may.datasets.map((d: { slug: string }) => d.slug), ["may"]);
  assert.equal(Number(may.rows[0].rows), 24);
  const rows = expectStatus(await query({ query: { mode: "ROWS", fields: ["consignee", "weight"], limit: 5 }, datasetIds: [a] }), 200);
  assert.equal(rows.rows.length, 5);
  assert.deepEqual(Object.keys(rows.rows[0]).sort(), ["consignee", "weight"]);
  const distinct = expectStatus(await query({ query: { mode: "AGGREGATE", measures: [{ operation: "COUNT_DISTINCT", fieldId: "consignee", alias: "n" }] }, datasetIds: [a] }), 200);
  assert.equal(Number(distinct.rows[0].n), 40);

  // Honest refusals instead of wrong numbers.
  assert.equal((await query({ query: { mode: "ROWS", fields: ["consignee"] } })).json().error.code, "GROUP_QUERY_ROWS_NEED_DATASET");
  assert.equal((await query({ query: { mode: "AGGREGATE", measures: [{ operation: "COUNT_DISTINCT", fieldId: "consignee", alias: "n" }] } })).json().error.code, "GROUP_QUERY_MEASURE_UNSUPPORTED");
  assert.equal((await query({ query: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }], filters: [{ fieldId: "nope", operator: "EQ", value: "x" }] } })).json().error.code, "DATASET_QUERY_FIELD_INVALID");
  assert.equal((await query({ query: total }, outsider.cookie)).statusCode, 404);
  assert.equal((await query({ query: total }, member.cookie)).statusCode, 403); // no north.data.query without a grant

  // Schema drift is visible.
  const fields = expectStatus(await call("GET", `${gBase}/fields`, owner.cookie), 200);
  assert.deepEqual(fields.fields.find((f: { key: string }) => f.key === "weight_kg").presentIn, ["june-renamed"]);
  assert.deepEqual(fields.fields.find((f: { key: string }) => f.key === "weight").missingIn, ["june-renamed"]);
  assert.equal(c.length > 0, true);

  // --- pipelines ---
  const pipeline = `${gBase}/pipeline`;
  const steps = [{ id: "receive", enabled: true }, { id: "clean_values", enabled: true }, { id: "detect_duplicates", enabled: false }];
  const script = expectStatus(await call("POST", `${gBase}/scripts`, owner.cookie, { slug: "clean-local", name: "Clean Local Import" }), 201);
  const v1 = expectStatus(await call("POST", `${gBase}/scripts/${script.id}/versions`, owner.cookie, { source: "def run(df, params):\n    return df\n", params: [{ name: "currency", type: "string", required: true, default: "USD" }, { name: "cutoff", type: "date", required: false }], steps, note: "first" }), 201);
  const v2 = expectStatus(await call("POST", `${gBase}/scripts/${script.id}/versions`, owner.cookie, { source: "def run(df, params):\n    return df.dropna()\n", params: v1.params, steps }), 201);
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.notEqual(v1.sourceSha256, v2.sourceSha256);
  assert.equal((await call("POST", `${gBase}/scripts/${script.id}/versions`, owner.cookie, { source: "x", params: [], steps: [{ id: "receive", enabled: true }, { id: "receive", enabled: false }] })).statusCode, 422);

  // Immutable at the database level: not even a direct write can change a published version.
  await assert.rejects(prisma.northPipelineScriptVersion.update({ where: { id: v1.id }, data: { source: "tampered" } }), /append-only/);
  await assert.rejects(prisma.northPipelineScriptVersion.delete({ where: { id: v1.id } }), /append-only/);

  // Differentiated permissions: a plain member can neither read, write, publish nor run; the owner holds all.
  for (const [method, url, body] of [["GET", pipeline, undefined], ["POST", `${gBase}/scripts`, { slug: "x1", name: "xx" }], ["PUT", pipeline, { scriptVersionId: v1.id }], ["POST", `${pipeline}/runs`, { kind: "TEST" }]] as const)
    assert.equal((await call(method, url, member.cookie, body)).statusCode, 403, `${method} ${url}`);
  assert.equal((await call("GET", pipeline, outsider.cookie)).statusCode, 404);

  // Publish, rollback, and the run record while execution is disabled.
  assert.equal((await call("POST", `${pipeline}/runs`, owner.cookie, { kind: "TEST" })).json().error.code, "PIPELINE_NOT_PUBLISHED");
  expectStatus(await call("PUT", pipeline, owner.cookie, { scriptVersionId: v2.id }), 200);
  expectStatus(await call("PUT", pipeline, owner.cookie, { scriptVersionId: v1.id }), 200); // rollback
  assert.equal(expectStatus(await call("GET", pipeline, owner.cookie), 200).activeScriptVersionId, v1.id);
  assert.equal((await call("POST", `${pipeline}/runs`, owner.cookie, { kind: "TEST", params: { nope: 1 } })).json().error.code, "PIPELINE_PARAM_UNKNOWN");
  assert.equal((await call("POST", `${pipeline}/runs`, owner.cookie, { kind: "TEST", params: { currency: 5 } })).json().error.code, "PIPELINE_PARAM_INVALID");
  assert.equal((await call("POST", `${pipeline}/runs`, owner.cookie, { kind: "REPROCESS" })).json().error.code, "PIPELINE_DATASET_REQUIRED");
  const blocked = expectStatus(await call("POST", `${pipeline}/runs`, owner.cookie, { kind: "REPROCESS", datasetId: a, params: { currency: "EUR" } }), 201);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.errorCode, "PIPELINE_SANDBOX_UNAVAILABLE");
  assert.equal(blocked.scriptVersionId, v1.id);
  assert.deepEqual(blocked.params, { currency: "EUR" });

  // With an isolated runner configured the same path records exact version, parameters and statistics.
  configurePipelineRunner({ enabled: true, async run(input) { return { stats: { rowsIn: 40, rowsOut: 38 }, report: { sha: input.sourceSha256 } }; } });
  const ok = expectStatus(await call("POST", `${pipeline}/runs`, owner.cookie, { kind: "REPROCESS", datasetId: a }), 201);
  assert.equal(ok.status, "SUCCEEDED");
  assert.deepEqual(ok.stats, { rowsIn: 40, rowsOut: 38 });
  assert.equal(ok.report.sha, v1.sourceSha256);
  configurePipelineRunner(new DisabledPipelineRunner());
  const history = expectStatus(await call("GET", `${pipeline}/runs?datasetId=${a}`, owner.cookie), 200);
  assert.equal(history.length, 2);
  assert.equal(history[0].datasetId, a);

  // A group with script history cannot be deleted, and the trail is audited.
  expectStatus(await call("PATCH", gBase, owner.cookie, { status: "ARCHIVED" }), 200);
  assert.equal((await call("DELETE", `${gBase}?detachDatasets=true`, owner.cookie)).json().error.code, "DATASET_GROUP_HAS_PIPELINE_HISTORY");
  const actions = (await prisma.auditLog.findMany({ where: { organizationId: org, action: { startsWith: "NORTH_PIPELINE_" } } })).map((r) => r.action);
  for (const expected of ["NORTH_PIPELINE_SCRIPT_CREATED", "NORTH_PIPELINE_VERSION_CREATED", "NORTH_PIPELINE_PUBLISHED", "NORTH_PIPELINE_RUN_RECORDED"]) assert.ok(actions.includes(expected), expected);
  const trail = JSON.stringify((await prisma.auditLog.findMany({ where: { organizationId: org, action: "NORTH_PIPELINE_VERSION_CREATED" } })).map((r) => r.metadata));
  assert.ok(!trail.includes("dropna"), "script source must never be copied into the audit log");
});
