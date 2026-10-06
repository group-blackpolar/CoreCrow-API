import { createHash } from "node:crypto";
import { Prisma } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize } from "../authorization/service.js";
import { computeTotals, lineTotal, money, parseQuantity, parseUnitPrice, quantityText } from "./money.js";
import { allowedTransitions, canTransition, documentStatuses, formatReference, isEditable, isSendable, permissionForTransition, type DocumentStatusValue } from "./status.js";
import { deliverEmail, deliverWhatsApp, deliveryChannels, normalizeWhatsAppNumber, type PdfFile } from "./delivery.js";
import { pdfLabels, renderDocumentPdf } from "./pdf.js";

/**
 * Documents are tenant-scoped records with a workflow. Every operation derives
 * the organization from authoritative membership (never from the client), is
 * default-deny through the registered `documents.*` permissions, and writes its
 * history to the existing audit log (targetType "Document").
 */
export type ItemInput = { name: string; description?: string; sku?: string | null; unit?: string | null; quantity: string; unitPrice: string };
export type ClientInput = { id?: string; name?: string; email?: string | null; phone?: string | null };
export type DocumentInput = { typeId: string; date?: string; client: ClientInput; items: ItemInput[]; comments?: string };

export const ATTACHMENT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxCount: 10, maxTotalBytes: 25 * 1024 * 1024 } as const;
const MAX_ITEMS = 100;

const notFound = (what = "Document"): never => fail(404, "NOT_FOUND", `${what} not found`);

// ---------------------------------------------------------------------------
// Views (strings for money, ISO strings for dates)
// ---------------------------------------------------------------------------

type DocumentRow = Prisma.DocumentGetPayload<{ include: { items: true; attachments: true; type: true } }>;

function documentView(row: DocumentRow) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status as DocumentStatusValue,
    allowedTransitions: [...allowedTransitions(row.status as DocumentStatusValue)],
    editable: isEditable(row.status as DocumentStatusValue),
    type: { id: row.type.id, key: row.type.key, name: row.type.name as Record<string, string>, referencePrefix: row.type.referencePrefix },
    date: row.documentDate.toISOString(),
    client: { id: row.clientId, name: row.clientName, email: row.clientEmail, phone: row.clientPhone },
    comments: row.comments,
    currency: row.currency,
    items: [...row.items].sort((a, b) => a.position - b.position).map((item) => ({
      id: item.id, position: item.position, name: item.name, description: item.description, sku: item.sku, unit: item.unit,
      quantity: quantityText(item.quantity), unitPrice: money(item.unitPrice), total: money(item.total),
    })),
    subtotal: money(row.subtotal),
    discountTotal: money(row.discountTotal),
    taxTotal: money(row.taxTotal),
    total: money(row.total),
    attachments: [...row.attachments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((item) => ({ id: item.id, filename: item.filename, mimeType: item.mimeType, size: item.size, createdAt: item.createdAt.toISOString() })),
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const include = { items: true, attachments: true, type: true } as const;

async function loadDocument(tx: Transaction, organizationId: string, id: string) {
  const row = await tx.document.findFirst({ where: { id, organizationId }, include });
  if (!row) notFound();
  return row!;
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function normalizeItems(items: ItemInput[]) {
  if (items.length === 0) fail(422, "DOCUMENT_ITEM_INVALID", "At least one item is required");
  if (items.length > MAX_ITEMS) fail(422, "DOCUMENT_ITEM_INVALID", `A document supports at most ${MAX_ITEMS} items`);
  const lines = items.map((item, position) => {
    const quantity = parseQuantity(item.quantity);
    const unitPrice = parseUnitPrice(item.unitPrice);
    const name = item.name.trim();
    if (!name) fail(422, "DOCUMENT_ITEM_INVALID", "Every item needs a name");
    return {
      position, name, description: (item.description ?? "").trim(), sku: item.sku?.trim() || null, unit: item.unit?.trim() || null,
      quantity, unitPrice, total: lineTotal(quantity, unitPrice),
    };
  });
  return { lines, totals: computeTotals(lines) };
}

async function resolveClient(tx: Transaction, organizationId: string, userId: string, input: ClientInput) {
  if (input.id) {
    const client = await tx.documentClient.findFirst({ where: { id: input.id, organizationId } });
    if (!client) notFound("Client");
    return { clientId: client!.id, name: client!.name, email: client!.email, phone: client!.phone };
  }
  const name = input.name?.trim() ?? "";
  if (name.length < 2) fail(422, "DOCUMENT_CLIENT_INVALID", "Client name is required");
  const email = input.email?.trim() || null;
  const emailKey = email ? email.toLowerCase() : null;
  const phone = input.phone?.trim() || null;
  // Reuse the organization's client when the email (or, without email, the exact name) matches, so
  // nobody has to retype it. Existing documents keep their own frozen snapshot.
  const existing = emailKey
    ? await tx.documentClient.findUnique({ where: { organizationId_emailKey: { organizationId, emailKey } } })
    : await tx.documentClient.findFirst({ where: { organizationId, emailKey: null, name: { equals: name, mode: "insensitive" } } });
  const client = existing
    ? await tx.documentClient.update({ where: { id: existing.id }, data: { name, phone: phone ?? existing.phone } })
    : await tx.documentClient.create({ data: { organizationId, name, email, emailKey, phone, createdBy: userId } });
  return { clientId: client.id, name: client.name, email: client.email, phone: client.phone };
}

function parseDocumentDate(value: string | undefined) {
  if (!value) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(422, "DOCUMENT_DATE_INVALID", "The document date is not valid");
  return date;
}

const sniff = (data: Buffer): "image/jpeg" | "image/png" | null => {
  if (data.length > 8 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
};

const safeFilename = (value: string) =>
  // eslint-disable-next-line no-control-regex
  value.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"<>|*?:]/g, "_").trim().slice(0, 120) || "image";

const maskEmail = (value: string) => value.replace(/^(.).*(@.*)$/, "$1***$2");
const maskPhone = (value: string) => `***${value.slice(-4)}`;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const documentsService = {
  // ---- types (configuration) ----------------------------------------------
  listTypes(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.read");
      const types = await tx.documentType.findMany({ where: { organizationId, status: "ACTIVE" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      return {
        types: types.map((type) => ({ id: type.id, key: type.key, name: type.name as Record<string, string>, referencePrefix: type.referencePrefix, currency: type.currency })),
        channels: deliveryChannels(),
      };
    });
  },

  createType(userId: string, organizationId: string, input: { key: string; name: Record<string, string>; referencePrefix: string; currency: string }) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.manage");
      const clash = await tx.documentType.findFirst({
        where: { organizationId, OR: [{ key: input.key }, { referencePrefix: input.referencePrefix }] },
      });
      if (clash) fail(409, "DOCUMENT_TYPE_EXISTS", "A document type with this key or prefix already exists");
      const type = await tx.documentType.create({
        data: { organizationId, key: input.key, name: input.name, referencePrefix: input.referencePrefix, currency: input.currency, createdBy: userId, sequence: { create: {} } },
      });
      await audit.append(tx, { actorId: userId, organizationId, action: "DOCUMENT_TYPE_CREATED", targetType: "DocumentType", targetId: type.id, metadata: { key: type.key, prefix: type.referencePrefix } });
      return { id: type.id, key: type.key, name: type.name as Record<string, string>, referencePrefix: type.referencePrefix, currency: type.currency };
    });
  },

  // ---- clients ---------------------------------------------------------------
  searchClients(userId: string, organizationId: string, q: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.read");
      const term = q.trim();
      const rows = await tx.documentClient.findMany({
        where: { organizationId, ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }] } : {}) },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: 20,
      });
      return rows.map((row) => ({ id: row.id, name: row.name, email: row.email, phone: row.phone }));
    });
  },

  // ---- documents ---------------------------------------------------------------
  list(userId: string, organizationId: string, query: { status?: DocumentStatusValue; typeId?: string; clientId?: string; q?: string; from?: Date; to?: Date; limit: number; cursor?: string }) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.read");
      const term = query.q?.trim();
      const rows = await tx.document.findMany({
        where: {
          organizationId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.typeId ? { typeId: query.typeId } : {}),
          ...(query.clientId ? { clientId: query.clientId } : {}),
          ...(query.from || query.to ? { documentDate: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
          ...(term ? { OR: [{ reference: { contains: term, mode: "insensitive" } }, { clientName: { contains: term, mode: "insensitive" } }, { clientEmail: { contains: term, mode: "insensitive" } }] } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: { type: true },
      });
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((row) => ({
          id: row.id, reference: row.reference, status: row.status as DocumentStatusValue, typeKey: row.type.key, clientName: row.clientName,
          date: row.documentDate.toISOString(), total: money(row.total), currency: row.currency, updatedAt: row.updatedAt.toISOString(),
        })),
        nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
      };
    });
  },

  get(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.read");
      return documentView(await loadDocument(tx, organizationId, id));
    });
  },

  create(userId: string, organizationId: string, input: DocumentInput) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.create");
      const type = await tx.documentType.findFirst({ where: { id: input.typeId, organizationId, status: "ACTIVE" } });
      if (!type) notFound("Document type");
      const { lines, totals } = normalizeItems(input.items);
      const client = await resolveClient(tx, organizationId, userId, input.client);
      // The row lock taken by this increment serializes concurrent creators: references never repeat.
      const counter = await tx.documentSequence.update({ where: { typeId: type!.id }, data: { lastValue: { increment: 1 } } });
      const reference = formatReference(type!.referencePrefix, counter.lastValue);
      const created = await tx.document.create({
        data: {
          organizationId, typeId: type!.id, sequence: counter.lastValue, reference,
          documentDate: parseDocumentDate(input.date),
          clientId: client.clientId, clientName: client.name, clientEmail: client.email, clientPhone: client.phone,
          comments: (input.comments ?? "").trim(), currency: type!.currency,
          subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, total: totals.total,
          createdBy: userId, updatedBy: userId,
          items: { create: lines.map((line) => ({ ...line })) },
        },
        include,
      });
      await audit.append(tx, { actorId: userId, organizationId, action: "DOCUMENT_CREATED", targetType: "Document", targetId: created.id, metadata: { reference, total: money(created.total), items: lines.length } });
      return documentView(created);
    }, { retries: 20 }); // every creator contends on the type's counter row
  },

  update(userId: string, organizationId: string, id: string, input: Omit<DocumentInput, "typeId"> & { expectedVersion: number }) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.update");
      const current = await loadDocument(tx, organizationId, id);
      if (!isEditable(current.status as DocumentStatusValue)) fail(409, "DOCUMENT_LOCKED", "Only draft or ready documents can be edited");
      if (current.version !== input.expectedVersion) fail(409, "VERSION_CONFLICT", "The document changed since it was loaded");
      const { lines, totals } = normalizeItems(input.items);
      const client = await resolveClient(tx, organizationId, userId, input.client);
      await tx.documentItem.deleteMany({ where: { documentId: id, organizationId } });
      const updated = await tx.document.update({
        where: { id },
        data: {
          documentDate: parseDocumentDate(input.date ?? current.documentDate.toISOString()),
          clientId: client.clientId, clientName: client.name, clientEmail: client.email, clientPhone: client.phone,
          comments: (input.comments ?? "").trim(),
          subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, total: totals.total,
          updatedBy: userId, version: { increment: 1 },
          items: { create: lines.map((line) => ({ ...line })) },
        },
        include,
      });
      await audit.append(tx, { actorId: userId, organizationId, action: "DOCUMENT_UPDATED", targetType: "Document", targetId: id, metadata: { reference: current.reference, total: money(updated.total), items: lines.length, version: updated.version } });
      return documentView(updated);
    });
  },

  changeStatus(userId: string, organizationId: string, id: string, to: DocumentStatusValue) {
    return transaction(async (tx) => {
      const current = await loadDocument(tx, organizationId, id).catch(() => null);
      // Authorize before revealing whether the id exists in this tenant.
      await authorize(tx, userId, organizationId, permissionForTransition(to));
      if (!current) notFound();
      const from = current!.status as DocumentStatusValue;
      if (!documentStatuses.includes(to) || !canTransition(from, to)) fail(409, "DOCUMENT_TRANSITION_INVALID", `A ${from} document cannot become ${to}`);
      if (from === "DRAFT" && to === "READY" && current!.items.length === 0) fail(422, "DOCUMENT_ITEM_INVALID", "A document needs items before it is ready");
      const updated = await tx.document.update({ where: { id }, data: { status: to, statusChangedAt: new Date(), updatedBy: userId, version: { increment: 1 } }, include });
      await audit.append(tx, { actorId: userId, organizationId, action: to === "CANCELLED" ? "DOCUMENT_CANCELLED" : "DOCUMENT_STATUS_CHANGED", targetType: "Document", targetId: id, metadata: { reference: current!.reference, from, to } });
      return documentView(updated);
    });
  },

  remove(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.delete");
      const current = await loadDocument(tx, organizationId, id);
      if (current.status !== "DRAFT") fail(409, "DOCUMENT_LOCKED", "Only drafts can be deleted; cancel the document instead");
      await tx.document.delete({ where: { id } });
      await audit.append(tx, { actorId: userId, organizationId, action: "DOCUMENT_DELETED", targetType: "Document", targetId: id, metadata: { reference: current.reference } });
      return { id };
    });
  },

  // ---- attachments -----------------------------------------------------------
  addAttachment(userId: string, organizationId: string, id: string, input: { filename: string; data: Buffer }) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.update");
      const current = await loadDocument(tx, organizationId, id);
      if (!isEditable(current.status as DocumentStatusValue)) fail(409, "DOCUMENT_LOCKED", "Attachments can only change while the document is a draft or ready");
      if (input.data.length === 0 || input.data.length > ATTACHMENT_LIMITS.maxBytes) fail(413, "ATTACHMENT_TOO_LARGE", "Each image can be at most 5 MiB");
      // The declared content type is never trusted: the file signature decides.
      const mime = sniff(input.data);
      if (!mime) fail(415, "ATTACHMENT_TYPE_NOT_ALLOWED", "Only JPEG and PNG images are supported");
      const existing = current.attachments;
      if (existing.length >= ATTACHMENT_LIMITS.maxCount) fail(409, "ATTACHMENT_LIMIT", "A document supports at most 10 attachments");
      if (existing.reduce((sum, item) => sum + item.size, 0) + input.data.length > ATTACHMENT_LIMITS.maxTotalBytes) fail(409, "ATTACHMENT_LIMIT", "The document attachments exceed 25 MiB");
      const attachment = await tx.documentAttachment.create({
        data: {
          organizationId, documentId: id, filename: safeFilename(input.filename), mimeType: mime!, size: input.data.length,
          sha256: createHash("sha256").update(input.data).digest("hex"), createdBy: userId,
          blob: { create: { data: Uint8Array.from(input.data) } },
        },
      });
      await tx.document.update({ where: { id }, data: { version: { increment: 1 }, updatedBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "DOCUMENT_ATTACHMENT_ADDED", targetType: "Document", targetId: id, metadata: { reference: current.reference, attachmentId: attachment.id, mime, size: attachment.size } });
      return { id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size, createdAt: attachment.createdAt.toISOString() };
    });
  },

  readAttachment(userId: string, organizationId: string, id: string, attachmentId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.read");
      const attachment = await tx.documentAttachment.findFirst({ where: { id: attachmentId, documentId: id, organizationId }, include: { blob: true } });
      if (!attachment?.blob) notFound("Attachment");
      return { filename: attachment!.filename, mimeType: attachment!.mimeType, data: Buffer.from(attachment!.blob!.data) };
    });
  },

  removeAttachment(userId: string, organizationId: string, id: string, attachmentId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.update");
      const current = await loadDocument(tx, organizationId, id);
      if (!isEditable(current.status as DocumentStatusValue)) fail(409, "DOCUMENT_LOCKED", "Attachments can only change while the document is a draft or ready");
      const attachment = await tx.documentAttachment.findFirst({ where: { id: attachmentId, documentId: id, organizationId } });
      if (!attachment) notFound("Attachment");
      await tx.documentAttachment.delete({ where: { id: attachmentId } });
      await tx.document.update({ where: { id }, data: { version: { increment: 1 }, updatedBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "DOCUMENT_ATTACHMENT_REMOVED", targetType: "Document", targetId: id, metadata: { reference: current.reference, attachmentId } });
      return { id: attachmentId };
    });
  },

  // ---- history ---------------------------------------------------------------
  events(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.read");
      await loadDocument(tx, organizationId, id);
      const rows = await tx.auditLog.findMany({ where: { organizationId, targetType: "Document", targetId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 });
      const actorIds = [...new Set(rows.map((row) => row.actorId).filter((value): value is string => Boolean(value)))];
      const members = actorIds.length
        ? await tx.membership.findMany({ where: { organizationId, userId: { in: actorIds } }, select: { userId: true, user: { select: { name: true, email: true } } } })
        : [];
      const names = new Map(members.map((member) => [member.userId, member.user.name?.trim() || member.user.email]));
      return rows.map((row) => ({
        id: row.id, action: row.action, actorId: row.actorId, actorName: row.actorId ? names.get(row.actorId) ?? null : null,
        createdAt: row.createdAt.toISOString(), metadata: (row.metadata ?? {}) as Record<string, unknown>,
      }));
    });
  },

  // ---- PDF ---------------------------------------------------------------
  async pdf(userId: string, organizationId: string, id: string, options: { language: "es" | "en"; purpose: "DOWNLOAD" | "DELIVERY" }): Promise<PdfFile & { reference: string }> {
    const loaded = await transaction(async (tx) => {
      await authorize(tx, userId, organizationId, options.purpose === "DOWNLOAD" ? "documents.download" : "documents.send");
      const row = await loadDocument(tx, organizationId, id);
      const organization = await tx.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
      const blobs = await tx.documentAttachment.findMany({ where: { documentId: id, organizationId }, include: { blob: true }, orderBy: { createdAt: "asc" } });
      await audit.append(tx, {
        actorId: userId, organizationId, action: options.purpose === "DOWNLOAD" ? "DOCUMENT_PDF_DOWNLOADED" : "DOCUMENT_PDF_GENERATED",
        targetType: "Document", targetId: id, metadata: { reference: row.reference, status: row.status },
      });
      return { row, issuer: organization?.name ?? "", blobs };
    });
    const view = documentView(loaded.row);
    const content = await renderDocumentPdf({
      issuer: loaded.issuer,
      typeName: (view.type.name[options.language] ?? view.type.name.es ?? view.type.name.en ?? Object.values(view.type.name)[0] ?? "").toString(),
      reference: view.reference, status: view.status, date: new Date(view.date), currency: view.currency,
      client: { name: view.client.name, email: view.client.email, phone: view.client.phone },
      items: view.items.map((item) => ({ name: item.name, description: item.description, quantity: item.quantity, unitPrice: item.unitPrice, total: item.total })),
      subtotal: view.subtotal, total: view.total, comments: view.comments,
      images: loaded.blobs.filter((item) => item.blob).map((item) => ({ filename: item.filename, mime: item.mimeType, data: Buffer.from(item.blob!.data) })),
      labels: pdfLabels[options.language],
    });
    return { filename: `${view.reference}.pdf`, content, reference: view.reference };
  },

  // ---- delivery ----------------------------------------------------------
  async sendEmail(userId: string, organizationId: string, id: string, input: { to?: string; subject?: string; message?: string; language: "es" | "en" }) {
    const target = await transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.send");
      const row = await loadDocument(tx, organizationId, id);
      if (!isSendable(row.status as DocumentStatusValue)) fail(409, "DOCUMENT_NOT_SENDABLE", "Finish the document (Ready) before sending it");
      return row;
    });
    const to = (input.to ?? target.clientEmail ?? "").trim();
    if (!to) fail(422, "DELIVERY_RECIPIENT_REQUIRED", "The client has no email address");
    const pdf = await documentsService.pdf(userId, organizationId, id, { language: input.language, purpose: "DELIVERY" });
    const subject = input.subject?.trim() || `${pdf.reference}`;
    const message = input.message?.trim() || `${pdf.reference}\n\n${target.clientName}`;
    try {
      await deliverEmail({ to, subject, message, pdf });
    } catch (error) {
      await documentsService.recordDelivery(userId, organizationId, id, "DOCUMENT_EMAIL_FAILED", { reference: pdf.reference, to: maskEmail(to), code: (error as { code?: string }).code ?? "DELIVERY_FAILED" });
      throw error;
    }
    return documentsService.recordDelivery(userId, organizationId, id, "DOCUMENT_EMAIL_SENT", { reference: pdf.reference, to: maskEmail(to) }, true);
  },

  async sendWhatsApp(userId: string, organizationId: string, id: string, input: { to?: string; message?: string; language: "es" | "en" }) {
    const target = await transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "documents.send");
      const row = await loadDocument(tx, organizationId, id);
      if (!isSendable(row.status as DocumentStatusValue)) fail(409, "DOCUMENT_NOT_SENDABLE", "Finish the document (Ready) before sending it");
      return row;
    });
    const to = normalizeWhatsAppNumber(input.to ?? target.clientPhone ?? "");
    if (!to) fail(422, "DELIVERY_RECIPIENT_REQUIRED", "A WhatsApp number with country code is required");
    const pdf = await documentsService.pdf(userId, organizationId, id, { language: input.language, purpose: "DELIVERY" });
    const message = input.message?.trim() || `${pdf.reference} · ${target.clientName}`;
    try {
      await deliverWhatsApp({ to: to!, message, reference: pdf.reference, pdf });
    } catch (error) {
      await documentsService.recordDelivery(userId, organizationId, id, "DOCUMENT_WHATSAPP_FAILED", { reference: pdf.reference, to: maskPhone(to!), code: (error as { code?: string }).code ?? "DELIVERY_FAILED" });
      throw error;
    }
    return documentsService.recordDelivery(userId, organizationId, id, "DOCUMENT_WHATSAPP_SENT", { reference: pdf.reference, to: maskPhone(to!) }, true);
  },

  /** Records the outcome and, after a successful delivery, moves READY documents to SENT. */
  recordDelivery(userId: string, organizationId: string, id: string, action: string, metadata: Prisma.InputJsonValue, markSent = false) {
    return transaction(async (tx) => {
      await audit.append(tx, { actorId: userId, organizationId, action, targetType: "Document", targetId: id, metadata });
      let row = await loadDocument(tx, organizationId, id);
      if (markSent && row.status === "READY") {
        row = await tx.document.update({ where: { id }, data: { status: "SENT", statusChangedAt: new Date(), updatedBy: userId, version: { increment: 1 } }, include });
        await audit.append(tx, { actorId: userId, organizationId, action: "DOCUMENT_STATUS_CHANGED", targetType: "Document", targetId: id, metadata: { reference: row.reference, from: "READY", to: "SENT", via: action } });
      }
      return documentView(row);
    });
  },
};
