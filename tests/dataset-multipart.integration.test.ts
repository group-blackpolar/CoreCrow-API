import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

test("resumable multipart upload: layout, resume, incomplete/wrong-size refusal, confirm and cancel cleanup", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5536?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5536, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { FakeObjectStorage } = await import("../src/infrastructure/object-storage.js");
  const { NorthDatasetImportService, configureNorthDatasetImportService, MULTIPART_PART_BYTES } = await import("../src/modules/north/data/import-service.js");
  const { datasetImportConfiguration } = await import("../src/modules/north/data/import-config.js");
  const storage = new FakeObjectStorage();
  configureNorthDatasetImportService(new NorthDatasetImportService({ storage, configuration: datasetImportConfiguration() }));
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const password = "Test-password-only-123!";
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  let address = 1;
  const call = (method: Method, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `127.0.90.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const expectStatus = (response: Res, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  const email = `${randomUUID().slice(0, 8)}-mp@blackpolar.test`;
  expectStatus(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: "127.0.91.10", headers: { origin: "http://localhost:3000" }, payload: { email, password, name: "mp" } }), 200);
  const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
  expectStatus(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
  const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: "127.0.92.11", headers: { origin: "http://localhost:3000" }, payload: { email, password } });
  expectStatus(login, 200);
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const org = expectStatus(await call("POST", "/v1/organizations", cookie, { name: `MP org ${randomUUID().slice(0, 8)}` }), 201).id as string;
  const dataset = expectStatus(await call("POST", `/v1/organizations/${org}/datasets`, cookie, { name: { en: "Big" }, slug: "big" }), 201).id as string;
  const base = `/v1/organizations/${org}/datasets/${dataset}/imports`;

  // 20 MiB: 8 + 8 + 4. The content starts with the ZIP magic so confirm accepts it.
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(20 * 1024 * 1024 - 4)]);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const prepared = expectStatus(await call("POST", base, cookie, { filename: "big.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: bytes.length, checksum }, { "idempotency-key": `mp-${checksum.slice(0, 40)}` }), 201);
  const importId = prepared.import.id as string;

  const state = expectStatus(await call("POST", `${base}/${importId}/multipart`, cookie), 201);
  assert.deepEqual([state.partSize, state.partCount, state.uploadedParts], [MULTIPART_PART_BYTES, 3, []]);
  const uploadId = [...storage.uploads.keys()][0]!;
  // starting again (page reload) returns the same upload, nothing duplicated
  expectStatus(await call("POST", `${base}/${importId}/multipart`, cookie), 201);
  assert.equal(storage.uploads.size, 1);

  const part = (n: number) => bytes.subarray((n - 1) * MULTIPART_PART_BYTES, Math.min(bytes.length, n * MULTIPART_PART_BYTES));
  assert.equal((await call("POST", `${base}/${importId}/multipart/parts/99`, cookie)).statusCode, 422);
  assert.ok(expectStatus(await call("POST", `${base}/${importId}/multipart/parts/1`, cookie), 200).url.includes("partNumber=1"));
  storage.putPart(uploadId, 1, part(1));
  storage.putPart(uploadId, 3, part(3).subarray(0, 100)); // truncated last part
  assert.deepEqual(expectStatus(await call("GET", `${base}/${importId}/multipart`, cookie), 200).uploadedParts, [1]); // resume: only valid parts count
  assert.equal((await call("POST", `${base}/${importId}/multipart/complete`, cookie)).json().error.code, "IMPORT_PARTS_INCOMPLETE");
  storage.putPart(uploadId, 2, part(2));
  storage.putPart(uploadId, 3, part(3));
  assert.deepEqual(expectStatus(await call("GET", `${base}/${importId}/multipart`, cookie), 200).uploadedParts, [1, 2, 3]);
  expectStatus(await call("POST", `${base}/${importId}/multipart/complete`, cookie), 200);
  const confirmed = expectStatus(await call("POST", `${base}/${importId}/confirm`, cookie), 202);
  assert.equal(confirmed.status, "SECURITY_PENDING");
  assert.equal(storage.objects.size, 1);
  assert.equal(Buffer.compare(Buffer.from([...storage.objects.values()][0]!.bytes), bytes), 0);
  // Leave nothing for other suites' workers to claim in the shared test database.
  expectStatus(await call("POST", `${base}/${importId}/cancel`, cookie), 200);

  // A cancelled import releases its stored parts.
  const second = expectStatus(await call("POST", base, cookie, { filename: "b.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: bytes.length, checksum: "c".repeat(64) }, { "idempotency-key": "mp-second-import-0001" }), 201);
  expectStatus(await call("POST", `${base}/${second.import.id}/multipart`, cookie), 201);
  assert.equal(storage.uploads.size, 1);
  expectStatus(await call("POST", `${base}/${second.import.id}/cancel`, cookie), 200);
  assert.equal(storage.uploads.size, 0);
  assert.equal((await call("POST", `${base}/${second.import.id}/multipart/parts/1`, cookie)).statusCode, 409);
});
