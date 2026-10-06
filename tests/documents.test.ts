import assert from "node:assert/strict";
import test from "node:test";
import { allows, effectivePermissions } from "../src/modules/authorization/policy.js";
import { DomainError } from "../src/shared/errors.js";
import { MetaCloudWhatsAppProvider, deliverEmail, deliverWhatsApp, deliveryChannels, normalizeWhatsAppNumber } from "../src/modules/documents/delivery.js";
import { computeTotals, formatMoney, lineTotal, money, parseQuantity, parseUnitPrice, quantityText } from "../src/modules/documents/money.js";
import { pdfLabels, renderDocumentPdf, type PdfDocumentInput } from "../src/modules/documents/pdf.js";
import { validateNorthPanelDocument } from "../src/modules/north/content-schema.js";
import { workspaceDocument } from "../src/modules/documents/workspace-panel.js";
import { allowedTransitions, canTransition, formatReference, isEditable, isSendable, permissionForTransition } from "../src/modules/documents/status.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("money: exact decimals, half-up cents per line, no floating point drift", () => {
  assert.equal(money(lineTotal(parseQuantity("2.5"), parseUnitPrice("19.99"))), "49.98");
  assert.equal(money(lineTotal(parseQuantity("3"), parseUnitPrice("0.10"))), "0.30"); // 0.1 * 3 is 0.30000000000000004 in floats
  assert.equal(money(lineTotal(parseQuantity("0.333"), parseUnitPrice("10.00"))), "3.33");
  const lines = [lineTotal(parseQuantity("2"), parseUnitPrice("20")), lineTotal(parseQuantity("1"), parseUnitPrice("15.50"))];
  const totals = computeTotals(lines.map((total) => ({ total })));
  assert.equal(money(totals.subtotal), "55.50");
  assert.equal(money(totals.total), "55.50");
  assert.equal(money(totals.discountTotal), "0.00");
  assert.equal(quantityText(parseQuantity("2.500")), "2.5");
  assert.equal(quantityText(parseQuantity("3")), "3");
});

test("money: invalid and oversized values are rejected", () => {
  for (const bad of ["0", "-1", "1e3", "abc", "", "1.5555", "12345"]) assert.throws(() => parseQuantity(bad), DomainError, `quantity ${bad}`);
  for (const bad of ["-0.01", "1.999", "1e3", "", "99999999"]) assert.throws(() => parseUnitPrice(bad), DomainError, `price ${bad}`);
  assert.throws(() => lineTotal(parseQuantity("9999"), parseUnitPrice("9999999")), DomainError);
  assert.equal(formatMoney("1234567.5", "USD"), "$1,234,567.50");
  assert.equal(formatMoney("10.00", "EUR"), "EUR 10.00");
});

test("workflow: terminal states cannot be revived and sending requires a finished document", () => {
  assert.deepEqual([...allowedTransitions("DRAFT")], ["READY", "CANCELLED"]);
  assert.equal(canTransition("DRAFT", "SENT"), false);
  assert.equal(canTransition("READY", "SENT"), true);
  assert.equal(canTransition("COMPLETED", "DRAFT"), false);
  assert.equal(canTransition("CANCELLED", "DRAFT"), false);
  assert.equal(isEditable("READY"), true);
  assert.equal(isEditable("SENT"), false);
  assert.equal(isSendable("DRAFT"), false);
  assert.equal(isSendable("CANCELLED"), false);
  assert.equal(isSendable("READY"), true);
  assert.equal(permissionForTransition("SENT"), "documents.send");
  assert.equal(permissionForTransition("CANCELLED"), "documents.update");
  assert.equal(formatReference("SEM", 21), "SEM-000021");
  assert.equal(formatReference("SEM", 1234567), "SEM-1234567");
});

test("permissions: roles are default-deny and additive", () => {
  const can = (role: string, permission: string) => allows(role, permission);
  for (const permission of ["documents.read", "documents.create", "documents.update", "documents.delete", "documents.download", "documents.send", "documents.manage"]) {
    assert.equal(can("OWNER", permission), true, `OWNER ${permission}`);
    assert.equal(can("ADMIN", permission), true, `ADMIN ${permission}`);
  }
  assert.deepEqual(["documents.read", "documents.create", "documents.update", "documents.download"].map((p) => can("MEMBER", p)), [true, true, true, true]);
  assert.deepEqual(["documents.delete", "documents.send", "documents.manage"].map((p) => can("MEMBER", p)), [false, false, false]);
  assert.deepEqual(["documents.read", "documents.download"].map((p) => can("VIEWER", p)), [true, true]);
  assert.deepEqual(["documents.create", "documents.update", "documents.delete", "documents.send", "documents.manage"].map((p) => can("VIEWER", p)), [false, false, false, false, false]);
  assert.equal(can("BILLING_ADMIN", "documents.read"), false, "billing admins get documents only through an explicit grant");
  assert.equal(can("BILLING_ADMIN", "documents.create"), false);
  assert.equal(can(undefined as unknown as string, "documents.read"), false);
  // A group grant adds a capability without granting anything else.
  assert.ok(effectivePermissions("VIEWER", ["documents.send"]).includes("documents.send"));
  assert.ok(!effectivePermissions("VIEWER", ["documents.send"]).includes("documents.delete"));
});

test("whatsapp: numbers are normalized to E.164 digits and anything else is refused", () => {
  assert.equal(normalizeWhatsAppNumber("+507 6000-0000"), "50760000000");
  assert.equal(normalizeWhatsAppNumber("(507) 6000 0000"), "50760000000");
  for (const bad of ["", "6000", "abc", "+0123456789", "1234567890123456"]) assert.equal(normalizeWhatsAppNumber(bad), null, bad);
});

test("delivery channels report missing configuration and never simulate a send", async () => {
  const saved = { smtp: process.env.SMTP_URL, from: process.env.MAIL_FROM, token: process.env.WHATSAPP_ACCESS_TOKEN, phone: process.env.WHATSAPP_PHONE_NUMBER_ID };
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    assert.equal(deliveryChannels().whatsapp, "not_configured");
    await assert.rejects(() => deliverWhatsApp({ to: "50760000000", message: "hi", reference: "SEM-000001", pdf: { filename: "a.pdf", content: Buffer.from("x") } }),
      (error: unknown) => error instanceof DomainError && (error as DomainError).statusCode === 503);
    if (!process.env.SMTP_URL || !process.env.MAIL_FROM) {
      assert.equal(deliveryChannels().email, "not_configured");
      await assert.rejects(() => deliverEmail({ to: "a@b.co", subject: "s", message: "m", pdf: { filename: "a.pdf", content: Buffer.from("x") } }),
        (error: unknown) => error instanceof DomainError && (error as DomainError).statusCode === 503);
    }
  } finally {
    for (const [key, value] of Object.entries({ SMTP_URL: saved.smtp, MAIL_FROM: saved.from, WHATSAPP_ACCESS_TOKEN: saved.token, WHATSAPP_PHONE_NUMBER_ID: saved.phone })) if (value !== undefined) process.env[key] = value;
  }
});

test("whatsapp provider: official Cloud API, token only in the Authorization header", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: init?.body });
    return new Response(JSON.stringify(String(url).endsWith("/media") ? { id: "media-1" } : { messages: [{ id: "wamid.1" }] }), { status: 200 });
  }) as typeof fetch;
  const provider = new MetaCloudWhatsAppProvider({ accessToken: "secret-token", phoneNumberId: "123", apiVersion: "v21.0", templateLanguage: "es" }, fake);
  const id = await provider.sendDocument({ to: "50760000000", message: "Su documento", reference: "SEM-000001", pdf: { filename: "SEM-000001.pdf", content: Buffer.from("%PDF-") } });
  assert.equal(id, "wamid.1");
  assert.equal(calls[0]!.url, "https://graph.facebook.com/v21.0/123/media");
  assert.equal(calls[1]!.url, "https://graph.facebook.com/v21.0/123/messages");
  assert.equal(calls[0]!.headers.authorization, "Bearer secret-token");
  const message = JSON.parse(String(calls[1]!.body));
  assert.equal(message.type, "document");
  assert.equal(message.document.id, "media-1");
  assert.ok(!JSON.stringify(message).includes("secret-token"), "the token never enters a payload");

  calls.length = 0;
  const templated = new MetaCloudWhatsAppProvider({ accessToken: "secret-token", phoneNumberId: "123", apiVersion: "v21.0", templateName: "documento_listo", templateLanguage: "es" }, fake);
  await templated.sendDocument({ to: "50760000000", message: "m", reference: "SEM-000001", pdf: { filename: "SEM-000001.pdf", content: Buffer.from("%PDF-") } });
  assert.equal(JSON.parse(String(calls[1]!.body)).template.name, "documento_listo");

  const failing = new MetaCloudWhatsAppProvider({ accessToken: "t", phoneNumberId: "1", apiVersion: "v21.0", templateLanguage: "es" }, (async () => new Response("{}", { status: 401 })) as typeof fetch);
  await assert.rejects(() => deliverWhatsApp({ to: "50760000000", message: "m", reference: "R", pdf: { filename: "r.pdf", content: Buffer.from("x") } }, failing), (error: unknown) => error instanceof DomainError && (error as DomainError).statusCode === 502);
});

const sample = (overrides: Partial<PdfDocumentInput> = {}): PdfDocumentInput => ({
  issuer: "Seminsa", typeName: "Forma", reference: "SEM-000021", status: "READY", date: new Date("2026-10-06T12:00:00Z"), currency: "USD",
  client: { name: "Empresa XYZ", email: "xyz@example.com", phone: "+507 6000-0000" },
  items: [{ name: "Item A", description: "Descripción", quantity: "2", unitPrice: "20.00", total: "40.00" }],
  subtotal: "40.00", total: "40.00", comments: "Gracias por su preferencia.", images: [], labels: pdfLabels.es, ...overrides,
});
const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

test("pdf: a real A4 document from data, paginated, with embedded images", async () => {
  const simple = await renderDocumentPdf(sample());
  assert.equal(simple.subarray(0, 5).toString(), "%PDF-");
  assert.ok(simple.toString("latin1").includes("/MediaBox [0 0 595.28 841.89]"), "A4 page size");
  assert.equal(pageCount(simple), 1);

  const many = await renderDocumentPdf(sample({ items: Array.from({ length: 90 }, (_, index) => ({ name: `Item ${index + 1}`, description: "Descripción larga ".repeat(6), quantity: "1", unitPrice: "1.00", total: "1.00" })), subtotal: "90.00", total: "90.00" }));
  assert.ok(pageCount(many) >= 3, `expected pagination, got ${pageCount(many)} pages`);

  const withImages = await renderDocumentPdf(sample({ images: [{ filename: "foto.png", mime: "image/png", data: PNG }, { filename: "corrupta.png", mime: "image/png", data: Buffer.from("not an image") }] }));
  assert.ok(pageCount(withImages) >= 2, "images go on their own page");
  assert.ok(withImages.length > simple.length);

  const english = await renderDocumentPdf(sample({ labels: pdfLabels.en }));
  assert.equal(english.subarray(0, 5).toString(), "%PDF-");
});

test("the document_workspace panel component is a strict, validated schema", async () => {
  const context = { organizationId: "o", actorId: "u", panelId: "p", validateBindingReference: async () => false };
  const valid = await validateNorthPanelDocument(workspaceDocument("forma", { es: "Formas", en: "Forms" }), context);
  assert.equal(valid.sections[0]!.components[0]!.type, "document_workspace");
  await assert.rejects(() => validateNorthPanelDocument(workspaceDocument("Not A Key", { es: "Formas", en: "Forms" }), context));
  const extra = workspaceDocument("forma", { es: "Formas", en: "Forms" });
  (extra.sections[0]!.components[0]!.props as Record<string, unknown>).script = "alert(1)";
  await assert.rejects(() => validateNorthPanelDocument(extra, context));
});
