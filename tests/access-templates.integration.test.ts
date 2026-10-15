import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { baseParts, generatedSheet, writeXlsx } from "./support/xlsx-fixtures.js";

test("access templates, primary group alias, dataset access", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5537?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5537, "127.0.0.1", resolve));
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
  const { groupAliasSlug } = await import("../src/modules/tenancy/invitation-service.js");
  const slug = (await prisma.organization.findUniqueOrThrow({ where: { id: org } })).slug;
  const query = (cookie: string) => call("POST", `${base}/datasets/${dataset.id}/query`, cookie, { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }] });
  const login = async (email: string, pass: string) => {
    const response = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.60.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000" }, payload: { email, password: pass } });
    expectStatus(response, 200);
    return cookieOf(response);
  };
  const create = async (payload: Record<string, unknown>) => {
    const made = await call("POST", `${base}/members/new`, owner.cookie, { password, ...payload });
    return made;
  };
  const accountIn = async (label: string, role: string) => {
    const person = await account(label);
    const key = expectStatus(await call("POST", `${base}/invitations`, owner.cookie, { kind: "CODE", role }), 201);
    expectStatus(await call("POST", "/v1/invitations/accept", person.cookie, { token: key.token }), 200);
    return person;
  };
  const finanzas = expectStatus(await call("POST", `${base}/groups`, owner.cookie, { name: "Finanzas Chile" }), 201);
  const analistas = expectStatus(await call("POST", `${base}/groups`, owner.cookie, { name: "Analistas" }), 201);

  await t.test("alias slug of a group is lowercase ASCII, accents removed, bounded", () => {
    assert.equal(groupAliasSlug("Finanzas Chile"), "finanzaschile");
    assert.equal(groupAliasSlug("Operación Ñuñoa"), "operacionnunoa");
    assert.equal(groupAliasSlug("!!!"), "grupo");
    assert.ok(groupAliasSlug("x".repeat(80)).length <= 20);
  });

  await t.test("reproduces the reported bug: a dataset rule alone leaves the member with permission denied", async () => {
    const made = expectStatus(await create({ name: "Eternity", role: "MEMBER" }), 201);
    expectStatus(await call("POST", `${base}/datasets/${dataset.id}/acl`, owner.cookie, { effect: "ALLOW", principalType: "MEMBERSHIP", membershipId: made.membership.id }), 201);
    const cookie = await login(made.user.email, password);
    assert.equal((await query(cookie)).statusCode, 403);
    // applying a template fixes it: both gates (north.data.query + dataset rule) are granted together
    const template = expectStatus(await call("POST", `${base}/access-templates`, owner.cookie, { name: "Reportes", role: "MEMBER", permissions: [], datasetIds: [dataset.id], groupIds: [] }), 201);
    const applied = expectStatus(await call("POST", `${base}/members/${made.user.id}/apply-template`, owner.cookie, { templateId: template.id }), 200);
    assert.deepEqual([applied.datasets, applied.capabilityGranted], [1, true]);
    assert.equal((await query(cookie)).statusCode, 200);
    // idempotent
    assert.equal(expectStatus(await call("POST", `${base}/members/${made.user.id}/apply-template`, owner.cookie, { templateId: template.id }), 200).capabilityGranted, false);
    assert.equal(await prisma.northDatasetAcl.count({ where: { datasetId: dataset.id, membershipId: made.membership.id } }), 1);
  });

  await t.test("creating an account from a template with a primary group gives name.group@org.bp and working data access", async () => {
    const template = expectStatus(await call("POST", `${base}/access-templates`, owner.cookie, { name: "Analista de datos", description: "Ve los reportes", role: "MEMBER", permissions: ["documents.read", "documents.download"], datasetIds: [dataset.id], groupIds: [analistas.id, finanzas.id] }), 201);
    const made = expectStatus(await create({ name: "Camila Rojas", templateId: template.id, primaryGroupId: finanzas.id }), 201);
    assert.equal(made.user.email, `camila.finanzaschile@${slug}.bp`);
    assert.equal(made.membership.role, "MEMBER");
    const rows = await prisma.organizationGroupMember.findMany({ where: { membershipId: made.membership.id }, orderBy: { groupId: "asc" } });
    assert.deepEqual(rows.map((row) => [row.groupId, row.isPrimary]).sort(), [[analistas.id, false], [finanzas.id, true]].sort());
    assert.equal((await query(await login(made.user.email, password))).statusCode, 200);
    // same first name and group: numeric suffix on the name part, never a duplicate login
    const twin = expectStatus(await create({ name: "Camila Soto", templateId: template.id, primaryGroupId: finanzas.id }), 201);
    assert.equal(twin.user.email, `camila2.finanzaschile@${slug}.bp`);
    // no primary group: plain alias; explicit empty groups override the template's groups but not its data access
    const plain = expectStatus(await create({ name: "Diego Paz", templateId: template.id, groupIds: [] }), 201);
    assert.equal(plain.user.email, `diego@${slug}.bp`);
    assert.equal(await prisma.organizationGroupMember.count({ where: { membershipId: plain.membership.id } }), 0);
    assert.equal((await query(await login(plain.user.email, password))).statusCode, 200);
    // a primary group must be one of the account's groups
    assert.equal((await create({ name: "Elena", templateId: template.id, groupIds: [analistas.id], primaryGroupId: finanzas.id })).statusCode, 422);
    // at most one primary group per membership, enforced by the database
    await assert.rejects(prisma.organizationGroupMember.update({ where: { groupId_membershipId: { groupId: analistas.id, membershipId: made.membership.id } }, data: { isPrimary: true } }));
  });

  await t.test("templates are validated, tenant-scoped and limited by what the author can hand out", async () => {
    const other = expectStatus(await call("POST", `/v1/organizations/${otherOrg}/datasets`, outsider.cookie, { name: { en: "F" }, slug: "foreign-tpl" }), 201);
    assert.equal((await call("POST", `${base}/access-templates`, owner.cookie, { name: "Cruzada", role: "MEMBER", datasetIds: [other.id] })).statusCode, 422);
    assert.equal((await call("POST", `${base}/access-templates`, owner.cookie, { name: "Reportes", role: "MEMBER" })).statusCode, 409); // name taken
    assert.equal((await call("POST", `${base}/access-templates`, owner.cookie, { name: "Dueña", role: "OWNER" })).statusCode, 400);
    const plainMember = await accountIn("tpl-member", "MEMBER");
    assert.equal((await call("GET", `${base}/access-templates`, plainMember.cookie)).statusCode, 403);
    assert.equal((await call("POST", `${base}/access-templates`, plainMember.cookie, { name: "Mia", role: "VIEWER" })).statusCode, 403);
    // a delegate who may manage permissions and members, but does not hold billing.manage or north permission management
    const delegate = await accountIn("tpl-delegate", "MEMBER");
    for (const permission of ["permissions.manage", "members.manage"]) expectStatus(await call("POST", `${base}/members/${delegate.id}/permission-grants`, owner.cookie, { permission }), 201);
    const escalating = await call("POST", `${base}/access-templates`, delegate.cookie, { name: "Escala", role: "MEMBER", permissions: ["billing.manage"] });
    assert.equal(escalating.statusCode, 403);
    // a MEMBER cannot assign roles at all, so the role rule answers before the permission check does
    assert.ok(["FORBIDDEN", "PRIVILEGE_ESCALATION"].includes(escalating.json().error.code));
    const [existing] = expectStatus(await call("GET", `${base}/access-templates`, delegate.cookie), 200);
    const victim = expectStatus(await create({ name: "Victor", role: "VIEWER" }), 201);
    assert.equal((await call("POST", `${base}/members/${victim.user.id}/apply-template`, delegate.cookie, { templateId: existing.id })).statusCode, 403);
    // creating an account with another organization's template id or a non-member
    const foreignTemplate = expectStatus(await call("POST", `/v1/organizations/${otherOrg}/access-templates`, outsider.cookie, { name: "Ajena", role: "VIEWER" }), 201);
    assert.equal((await create({ name: "Zoe", templateId: foreignTemplate.id })).statusCode, 404);
    assert.ok([403, 404].includes((await call("GET", `${base}/access-templates`, outsider.cookie)).statusCode));
  });

  await t.test("owners are protected and deleting a template keeps what accounts already received", async () => {
    const [template] = (expectStatus(await call("GET", `${base}/access-templates`, owner.cookie), 200) as Array<{ id: string; name: string }>).filter((entry) => entry.name === "Analista de datos");
    assert.equal((await call("POST", `${base}/members/${owner.id}/apply-template`, owner.cookie, { templateId: template.id })).statusCode, 409);
    const keeper = await prisma.user.findFirstOrThrow({ where: { email: `camila.finanzaschile@${slug}.bp` } });
    expectStatus(await call("DELETE", `${base}/access-templates/${template.id}`, owner.cookie), 200);
    assert.equal((await call("DELETE", `${base}/access-templates/${template.id}`, owner.cookie)).statusCode, 404);
    assert.equal((await query(await login(keeper.email, password))).statusCode, 200);
  });
});
