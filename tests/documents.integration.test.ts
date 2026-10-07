import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("Documents integration", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5526?ignoreTLS=true";
  process.env.MAIL_FROM = "documents@blackpolar.test";
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  const messages: string[] = [];
  const smtp = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, callback) {
      let value = "";
      stream.on("data", (data) => { value += data; });
      stream.on("end", () => { messages.push(value); callback(); });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(5526, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `127.0.2.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const expect = (response: Awaited<ReturnType<typeof call>>, status: number) => {
    assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`);
    return response.json();
  };
  const cookieOf = (response: Awaited<ReturnType<typeof call>>) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  let signupAddress = 10;
  async function signup(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    const remoteAddress = `127.0.3.${signupAddress++}`;
    expect(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const record = await prisma.user.findUniqueOrThrow({ where: { email } });
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expect(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress, headers: { origin: "http://localhost:3000" }, payload: { email, password } });
    expect(login, 200);
    return { id: record.id, email, cookie: cookieOf(login) };
  }

  const owner = await signup("owner");
  const member = await signup("member");
  const viewer = await signup("viewer");
  const outsider = await signup("outsider");
  const rival = await signup("rival");

  const organization = expect(await call("POST", "/v1/organizations", owner.cookie, { name: `Seminsa ${prefix}`, slug: `seminsa-${prefix}` }), 201);
  const orgId: string = organization.id;
  await prisma.membership.createMany({ data: [{ organizationId: orgId, userId: member.id, role: "MEMBER" }, { organizationId: orgId, userId: viewer.id, role: "VIEWER" }] });
  const rivalOrg = expect(await call("POST", "/v1/organizations", rival.cookie, { name: `Rival ${prefix}`, slug: `rival-${prefix}` }), 201);
  const base = `/v1/organizations/${orgId}`;

  let typeId = "";
  await t.test("document types: manage is required, prefix and key are unique", async () => {
    const body = { key: "forma", name: { es: "Forma", en: "Form" }, referencePrefix: "SEM", currency: "USD" };
    expect(await call("POST", `${base}/document-types`, member.cookie, body), 403);
    expect(await call("POST", `${base}/document-types`, outsider.cookie, body), 404);
    const created = expect(await call("POST", `${base}/document-types`, owner.cookie, body), 201);
    typeId = created.id;
    expect(await call("POST", `${base}/document-types`, owner.cookie, { ...body, key: "otra" }), 409);
    const listed = expect(await call("GET", `${base}/document-types`, viewer.cookie), 200);
    assert.equal(listed.types.length, 1);
    assert.equal(listed.channels.email, "available");
    assert.equal(listed.channels.whatsapp, "not_configured");
  });

  const item = (name: string, quantity: string, unitPrice: string) => ({ name, description: `${name} description`, quantity, unitPrice });
  const draft = (extra: Record<string, unknown> = {}) => ({
    typeId, client: { name: "Cliente Uno", email: "Cliente@Example.com", phone: "+507 6000-0000" },
    items: [item("Item A", "2", "20.00"), item("Item B", "2.5", "19.99")], comments: "Notas del cliente", ...extra,
  });
  let first: { id: string; reference: string; version: number; client: { id: string } };

  await t.test("create: server assigns the reference and exact totals", async () => {
    expect(await call("POST", `${base}/documents`, viewer.cookie, draft()), 403);
    expect(await call("POST", `${base}/documents`, outsider.cookie, draft()), 404);
    first = expect(await call("POST", `${base}/documents`, member.cookie, draft()), 201);
    assert.equal(first.reference, "SEM-000001");
    const body = first as unknown as { status: string; subtotal: string; total: string; items: Array<{ total: string }>; allowedTransitions: string[] };
    assert.equal(body.status, "DRAFT");
    assert.deepEqual(body.items.map((line) => line.total), ["40.00", "49.98"]); // 2.5 * 19.99 = 49.975 -> half-up
    assert.equal(body.subtotal, "89.98");
    assert.equal(body.total, "89.98");
    assert.deepEqual(body.allowedTransitions, ["READY", "CANCELLED"]);
    expect(await call("POST", `${base}/documents`, member.cookie, draft({ items: [] })), 400);
    expect(await call("POST", `${base}/documents`, member.cookie, draft({ items: [item("x", "-1", "1")] })), 400);
    expect(await call("POST", `${base}/documents`, member.cookie, draft({ items: [item("x", "1", "1.999")] })), 400);
  });

  await t.test("references never repeat under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => call("POST", `${base}/documents`, member.cookie, draft())));
    const references = results.map((response) => expect(response, 201).reference as string);
    assert.equal(new Set(references).size, 6);
    const sequences = references.map((value) => Number(value.slice(4))).sort((a, b) => a - b);
    assert.deepEqual(sequences, [2, 3, 4, 5, 6, 7]);
  });

  await t.test("clients are reused by email and documents keep a frozen snapshot", async () => {
    const second = expect(await call("POST", `${base}/documents`, member.cookie, draft({ client: { name: "Cliente Uno SA", email: "cliente@example.com" } })), 201);
    assert.equal(second.client.id, first.client.id);
    const found = expect(await call("GET", `${base}/document-clients?q=uno`, member.cookie), 200);
    assert.equal(found.length, 1);
    const reread = expect(await call("GET", `${base}/documents/${first.id}`, member.cookie), 200);
    assert.equal(reread.client.name, "Cliente Uno", "an older document is not rewritten by a later client edit");
  });

  await t.test("list filters, search and tenant isolation", async () => {
    const all = expect(await call("GET", `${base}/documents?limit=100`, viewer.cookie), 200);
    assert.ok(all.items.length >= 8);
    const page = expect(await call("GET", `${base}/documents?limit=3`, viewer.cookie), 200);
    assert.equal(page.items.length, 3);
    assert.ok(page.nextCursor);
    const next = expect(await call("GET", `${base}/documents?limit=3&cursor=${page.nextCursor}`, viewer.cookie), 200);
    assert.notEqual(next.items[0].id, page.items[0].id);
    assert.equal(expect(await call("GET", `${base}/documents?q=SEM-000001`, viewer.cookie), 200).items.length, 1);
    assert.equal(expect(await call("GET", `${base}/documents?status=SENT`, viewer.cookie), 200).items.length, 0);
    expect(await call("GET", `${base}/documents`, outsider.cookie), 404);
    // Cross-tenant: another organization's owner can neither list nor read these documents.
    expect(await call("GET", `${base}/documents/${first.id}`, rival.cookie), 404);
    expect(await call("GET", `/v1/organizations/${rivalOrg.id}/documents/${first.id}`, rival.cookie), 404);
  });

  await t.test("update: optimistic version and permissions", async () => {
    const body = { client: { id: first.client.id }, items: [item("Solo uno", "1", "10.00")], comments: "editado", expectedVersion: first.version };
    expect(await call("PUT", `${base}/documents/${first.id}`, viewer.cookie, body), 403);
    const updated = expect(await call("PUT", `${base}/documents/${first.id}`, member.cookie, body), 200);
    assert.equal(updated.version, first.version + 1);
    assert.equal(updated.total, "10.00");
    expect(await call("PUT", `${base}/documents/${first.id}`, member.cookie, body), 409); // stale version
    first = updated;
  });

  await t.test("attachments: signature decides, bytes round-trip, locked after sending", async () => {
    const url = `${base}/documents/${first.id}/attachments?filename=foto.png`;
    const sent = (payload: Buffer, contentType: string) => app.inject({ method: "POST", url, remoteAddress: `127.0.4.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", cookie: member.cookie, "content-type": contentType }, payload });
    assert.equal((await sent(Buffer.from("<html>not an image</html>"), "image/png")).statusCode, 415);
    assert.ok([400, 415].includes((await sent(PNG, "application/json")).statusCode), "a non-image content type is refused");
    const created = expect(await sent(PNG, "image/png"), 201);
    assert.equal(created.mimeType, "image/png");
    const downloaded = await call("GET", `${base}/documents/${first.id}/attachments/${created.id}`, viewer.cookie);
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.headers["content-type"], "image/png");
    assert.ok(Buffer.from(downloaded.rawPayload).equals(PNG));
    assert.equal((await call("GET", `${base}/documents/${first.id}/attachments/${created.id}`, rival.cookie)).statusCode, 404);
    const detail = expect(await call("GET", `${base}/documents/${first.id}`, member.cookie), 200);
    assert.equal(detail.attachments.length, 1);
    expect(await call("DELETE", `${base}/documents/${first.id}/attachments/${created.id}`, viewer.cookie), 403);
    expect(await call("DELETE", `${base}/documents/${first.id}/attachments/${created.id}`, member.cookie), 200);
    await sent(PNG, "image/png"); // keep one image so the PDF embeds it
  });

  await t.test("attachments: JPEG, PNG and WebP are accepted, corrupt files refused, at most 10, and every image reaches the PDF", async () => {
    const { default: sharp } = await import("sharp");
    const swatch = (format: "jpeg" | "png" | "webp", color: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: color } })[format]().toBuffer();
    const doc = expect(await call("POST", `${base}/documents`, member.cookie, draft()), 201);
    const upload = (payload: Buffer, filename: string, contentType: string) => app.inject({
      method: "POST", url: `${base}/documents/${doc.id}/attachments?filename=${encodeURIComponent(filename)}`, remoteAddress: `127.0.4.${address++ % 250 + 1}`,
      headers: { origin: "http://localhost:3000", cookie: member.cookie, "content-type": contentType }, payload,
    });
    const jpeg = await swatch("jpeg", "#cc3333");
    const png = await swatch("png", "#33cc33");
    const webp = await swatch("webp", "#3333cc");
    const a = expect(await upload(jpeg, "foto.jpg", "image/jpeg"), 201);
    const b = expect(await upload(png, "captura.PNG", "image/png"), 201);
    const c = expect(await upload(webp, "imagen.webp", "image/webp"), 201);
    assert.deepEqual([a.mimeType, b.mimeType, c.mimeType], ["image/jpeg", "image/png", "image/webp"]);
    // The signature decides, not the declared type or the extension.
    assert.equal(expect(await upload(webp, "disfrazada.png", "image/png"), 201).mimeType, "image/webp");
    // Corrupt / spoofed files are refused with 415 and nothing is stored.
    assert.equal((await upload(Buffer.concat([webp.subarray(0, 20), Buffer.from("garbage")]), "rota.webp", "image/webp")).statusCode, 415);
    assert.equal((await upload(Buffer.from("RIFF0000WAVEfmt "), "audio.webp", "image/webp")).statusCode, 415);
    assert.equal((await upload(Buffer.from("GIF89a....."), "anim.gif", "image/gif")).statusCode, 415);
    // WebP bytes round-trip unchanged and are served with their own type.
    const served = await call("GET", `${base}/documents/${doc.id}/attachments/${c.id}`, viewer.cookie);
    assert.equal(served.headers["content-type"], "image/webp");
    assert.ok(Buffer.from(served.rawPayload).equals(webp));
    // Four stored so far; fill up to ten, the eleventh is refused.
    for (let index = 0; index < 6; index += 1) expect(await upload(jpeg, `extra-${index}.jpeg`, "image/jpeg"), 201);
    const eleventh = await upload(jpeg, "once.jpg", "image/jpeg");
    assert.equal(eleventh.statusCode, 409, eleventh.body);
    assert.equal(eleventh.json().error?.code ?? eleventh.json().code, "ATTACHMENT_LIMIT");
    const detail = expect(await call("GET", `${base}/documents/${doc.id}`, member.cookie), 200);
    assert.equal(detail.attachments.length, 10);
    // All ten images are embedded in the PDF (JPEG, PNG and the converted WebP).
    const pdf = await call("GET", `${base}/documents/${doc.id}/pdf`, viewer.cookie);
    assert.equal(pdf.statusCode, 200, pdf.body);
    const imageObjects = (Buffer.from(pdf.rawPayload).toString("latin1").match(/\/Subtype \/Image/g) ?? []).length;
    assert.ok(imageObjects >= 10, `expected at least 10 image objects in the PDF, found ${imageObjects}`);
  });

  await t.test("workflow: transitions are validated and gated by permission", async () => {
    const status = (to: string, cookie = member.cookie) => call("POST", `${base}/documents/${first.id}/status`, cookie, { status: to });
    assert.equal((await status("SENT", owner.cookie)).statusCode, 409); // DRAFT cannot jump to SENT
    assert.equal((await status("SENT")).statusCode, 403); // and a member may not mark SENT at all
    assert.equal((await status("READY", viewer.cookie)).statusCode, 403);
    const ready = expect(await status("READY"), 200);
    assert.equal(ready.status, "READY");
    assert.equal((await status("SENT")).statusCode, 403); // marking SENT needs documents.send
    assert.equal((await status("DRAFT")).statusCode, 200);
    assert.equal((await status("READY")).statusCode, 200);
  });

  await t.test("PDF: download is permissioned, real PDF, audited", async () => {
    expect(await call("GET", `${base}/documents/${first.id}/pdf`, outsider.cookie), 404);
    const response = await call("GET", `${base}/documents/${first.id}/pdf`, viewer.cookie);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["content-type"], "application/pdf");
    assert.match(String(response.headers["content-disposition"]), /SEM-000001\.pdf/);
    assert.equal(Buffer.from(response.rawPayload).subarray(0, 5).toString(), "%PDF-");
    const events = expect(await call("GET", `${base}/documents/${first.id}/events`, viewer.cookie), 200);
    assert.ok(events.some((event: { action: string }) => event.action === "DOCUMENT_PDF_DOWNLOADED"));
    assert.ok(events.some((event: { action: string }) => event.action === "DOCUMENT_CREATED"));
    assert.ok(events.every((event: { actorName: string | null }) => event.actorName !== undefined));
  });

  await t.test("email: sends the PDF, marks SENT, never simulates", async () => {
    const send = (cookie: string, id = first.id, body: object = {}) => call("POST", `${base}/documents/${id}/send/email`, cookie, body);
    assert.equal((await send(viewer.cookie)).statusCode, 403);
    assert.equal((await send(member.cookie)).statusCode, 403); // MEMBER has no documents.send
    const other = expect(await call("POST", `${base}/documents`, owner.cookie, draft()), 201);
    assert.equal((await send(owner.cookie, other.id)).statusCode, 409); // still a draft
    const before = messages.length;
    const sent = expect(await send(owner.cookie, first.id, { subject: "Su documento", message: "Adjunto el documento." }), 200);
    assert.equal(sent.status, "SENT");
    assert.equal(messages.length, before + 1);
    const mail = messages.at(-1)!;
    assert.match(mail, /application\/pdf/);
    assert.match(mail, /SEM-000001\.pdf/);
    assert.match(mail, /Subject: Su documento/);
    const events = expect(await call("GET", `${base}/documents/${first.id}/events`, owner.cookie), 200);
    const emailEvent = events.find((event: { action: string }) => event.action === "DOCUMENT_EMAIL_SENT");
    assert.ok(emailEvent);
    assert.match(String(emailEvent.metadata.to), /^c\*\*\*@example\.com$/i, "audit stores a masked address");
    assert.equal((await call("PUT", `${base}/documents/${first.id}`, owner.cookie, { client: { id: first.client.id }, items: [item("x", "1", "1.00")], expectedVersion: sent.version })).statusCode, 409, "a sent document is locked");
  });

  await t.test("whatsapp: reports the missing configuration instead of simulating", async () => {
    const response = await call("POST", `${base}/documents/${first.id}/send/whatsapp`, owner.cookie, { to: "+50760000000" });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, "WHATSAPP_NOT_CONFIGURED");
    const events = expect(await call("GET", `${base}/documents/${first.id}/events`, owner.cookie), 200);
    assert.ok(!events.some((event: { action: string }) => event.action === "DOCUMENT_WHATSAPP_SENT"));
  });

  await t.test("delete: drafts only, with delete permission", async () => {
    const disposable = expect(await call("POST", `${base}/documents`, member.cookie, draft()), 201);
    assert.equal((await call("DELETE", `${base}/documents/${disposable.id}`, member.cookie)).statusCode, 403);
    assert.equal((await call("DELETE", `${base}/documents/${first.id}`, owner.cookie)).statusCode, 409);
    assert.equal((await call("DELETE", `${base}/documents/${disposable.id}`, owner.cookie)).statusCode, 200);
    assert.equal((await call("GET", `${base}/documents/${disposable.id}`, owner.cookie)).statusCode, 404);
  });

  await t.test("status endpoint authorizes before revealing existence", async () => {
    const response = await call("POST", `${base}/documents/does-not-exist/status`, viewer.cookie, { status: "READY" });
    assert.equal(response.statusCode, 403);
  });
});
