import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

test("dataset groups: periods, overlap, summary, tenant isolation, delete scope, audit", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5533?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5533, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.60.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const expectStatus = (response: Res, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  const cookieOf = (response: Res) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  let signupAddress = 10;
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    expectStatus(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: `127.0.61.${signupAddress++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expectStatus(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.62.${signupAddress++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password } });
    expectStatus(login, 200);
    return { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, cookie: cookieOf(login) };
  }

  const owner = await account("owner");
  const outsider = await account("outsider");
  const org = expectStatus(await call("POST", "/v1/organizations", owner.cookie, { name: `Groups ${prefix}` }), 201).id as string;
  const otherOrg = expectStatus(await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` }), 201).id as string;
  const base = `/v1/organizations/${org}`;
  const dataset = async (slug: string) => expectStatus(await call("POST", `${base}/datasets`, owner.cookie, { name: { en: slug }, slug }), 201).id as string;

  // A standalone dataset is untouched by the feature.
  const standalone = expectStatus(await call("POST", `${base}/datasets`, owner.cookie, { name: { en: "Legacy" }, slug: "legacy" }), 201);
  assert.equal(standalone.groupId, null);
  assert.equal(standalone.periodStart, null);

  // Unauthenticated and cross-tenant callers see nothing.
  assert.equal((await call("GET", `${base}/dataset-groups`)).statusCode, 401);
  assert.equal((await call("GET", `${base}/dataset-groups`, outsider.cookie)).statusCode, 404);
  assert.equal((await call("POST", `${base}/dataset-groups`, outsider.cookie, { slug: "x", name: { en: "X" } })).statusCode, 404);

  const group = expectStatus(await call("POST", `${base}/dataset-groups`, owner.cookie, { slug: "local-import", name: { en: "Local Import" }, category: "imports", tags: ["customs"], metadata: { source: "ops" } }), 201);
  assert.equal(group.summary.health, "EMPTY");
  assert.equal(group.summary.datasetCount, 0);
  assert.equal(expectStatus(await call("POST", `${base}/dataset-groups`, owner.cookie, { slug: "local-import", name: { en: "Dup" } }).then((r) => r), 409).error?.code ?? "DATASET_GROUP_CONFLICT", "DATASET_GROUP_CONFLICT");

  const h1 = await dataset("li-2024-h1");
  const h2 = await dataset("li-2024-h2");
  const assign = (id: string, body: object, cookie = owner.cookie) => call("PUT", `${base}/datasets/${id}/group`, cookie, body);
  expectStatus(await assign(h1, { groupId: group.id, periodStart: "2024-01-01", periodEnd: "2024-06-30", periodLabel: "H1 2024" }), 200);
  const overlapping = await dataset("li-overlap");
  const refused = await assign(overlapping, { groupId: group.id, periodStart: "2024-06-01", periodEnd: "2024-07-31" });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error?.code ?? refused.json().code, "PERIOD_OVERLAP");
  assert.equal((await assign(overlapping, { groupId: group.id, periodStart: "2024-08-01", periodEnd: "2024-07-01" })).statusCode, 422);
  expectStatus(await assign(h2, { groupId: group.id, periodStart: "2024-07-01", periodEnd: "2024-12-31" }), 200);
  expectStatus(await assign(overlapping, { groupId: group.id, periodStart: "2024-06-01", periodEnd: "2024-07-31", allowOverlap: true }), 200);
  expectStatus(await assign(overlapping, { groupId: null }), 200);

  // A dataset of another tenant's group cannot be targeted, nor can a foreign dataset be reached.
  const foreign = expectStatus(await call("POST", `/v1/organizations/${otherOrg}/dataset-groups`, outsider.cookie, { slug: "foreign", name: { en: "Foreign" } }), 201);
  assert.equal((await assign(h1, { groupId: foreign.id })).statusCode, 404);
  assert.equal((await call("GET", `${base}/dataset-groups/${foreign.id}`, owner.cookie)).statusCode, 404);

  const detail = expectStatus(await call("GET", `${base}/dataset-groups/${group.id}`, owner.cookie), 200);
  assert.equal(detail.summary.datasetCount, 2);
  assert.equal(detail.summary.periodStart, "2024-01-01");
  assert.equal(detail.summary.periodEnd, "2024-12-31");
  assert.deepEqual(detail.datasets.map((d: { slug: string }) => d.slug), ["li-2024-h1", "li-2024-h2"]);
  assert.equal(expectStatus(await call("GET", `${base}/dataset-groups`, owner.cookie), 200)[0].summary.datasetCount, 2);

  // Archived groups refuse new datasets; deleting needs archive, then an explicit detach, and never erases datasets.
  expectStatus(await call("PATCH", `${base}/dataset-groups/${group.id}`, owner.cookie, { status: "ARCHIVED" }), 200);
  assert.equal((await assign(overlapping, { groupId: group.id })).statusCode, 409);
  const scope = expectStatus(await call("GET", `${base}/dataset-groups/${group.id}/dependencies`, owner.cookie), 200);
  assert.equal(scope.datasets, 2);
  assert.equal((await call("DELETE", `${base}/dataset-groups/${group.id}`, owner.cookie)).statusCode, 409);
  expectStatus(await call("DELETE", `${base}/dataset-groups/${group.id}?detachDatasets=true`, owner.cookie), 200);
  assert.equal(await prisma.northDataset.count({ where: { organizationId: org, id: { in: [h1, h2] }, groupId: null } }), 2);
  assert.equal(await prisma.northDatasetGroup.count({ where: { id: group.id } }), 0);

  // Audit: business events were recorded, attributed and scoped to the organization.
  const actions = (await prisma.auditLog.findMany({ where: { organizationId: org, action: { startsWith: "NORTH_DATASET_GROUP_" } }, orderBy: { createdAt: "asc" } })).map((row) => row.action);
  for (const expected of ["NORTH_DATASET_GROUP_CREATED", "NORTH_DATASET_GROUP_ASSIGNED", "NORTH_DATASET_GROUP_REMOVED", "NORTH_DATASET_GROUP_ARCHIVED", "NORTH_DATASET_GROUP_DELETED"])
    assert.ok(actions.includes(expected), `missing audit ${expected}`);
  assert.equal(await prisma.auditLog.count({ where: { organizationId: otherOrg, action: "NORTH_DATASET_GROUP_ASSIGNED" } }), 0);

  // The audit endpoint is manager-only and tenant-scoped.
  const kept = expectStatus(await call("POST", `${base}/dataset-groups`, owner.cookie, { slug: "kept", name: { en: "Kept" } }), 201);
  expectStatus(await assign(h1, { groupId: kept.id, periodStart: "2025-01-01", periodEnd: "2025-01-31" }), 200);
  const trail = expectStatus(await call("GET", `${base}/dataset-groups/${kept.id}/audit`, owner.cookie), 200);
  assert.deepEqual(trail.map((row: { action: string }) => row.action).sort(), ["NORTH_DATASET_GROUP_ASSIGNED", "NORTH_DATASET_GROUP_CREATED"]);
  assert.equal((await call("GET", `${base}/dataset-groups/${kept.id}/audit`, outsider.cookie)).statusCode, 404);
});
