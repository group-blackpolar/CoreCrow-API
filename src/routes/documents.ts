import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { contract } from "../contracts/route.js";
import * as s from "../contracts/schemas.js";
import { documentsService, ATTACHMENT_LIMITS } from "../modules/documents/service.js";
import { documentStatuses } from "../modules/documents/status.js";
import { principal } from "../modules/security/session.js";
import { withRequestContext } from "../shared/request-context.js";

const language = z.enum(["es", "en"]).default("es");
const quantity = z.string().regex(/^\d{1,4}(\.\d{1,3})?$/);
const price = z.string().regex(/^\d{1,7}(\.\d{1,2})?$/);
const amount = z.string().regex(/^\d{1,12}(\.\d{2})$/);
const status = z.enum(documentStatuses);
const localizedName = z.record(z.string().regex(/^[a-z]{2}$/), z.string().trim().min(1).max(120));

const docParams = s.orgParams.extend({ documentId: s.id });
const itemInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(""),
  sku: z.string().trim().max(60).nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  quantity,
  unitPrice: price,
}).strict();
const clientInput = z.object({
  id: s.id.optional(),
  name: z.string().trim().min(2).max(200).optional(),
  email: z.string().trim().max(254).refine((value) => value === "" || z.string().email().safeParse(value).success, "Invalid email address").nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
}).strict().refine((value) => Boolean(value.id || value.name), "Select a client or provide a name");
const documentBody = z.object({
  typeId: s.id,
  date: z.string().datetime({ offset: true }).optional(),
  client: clientInput,
  items: z.array(itemInput).min(1).max(100),
  comments: z.string().max(10_000).default(""),
}).strict();

const typeView = z.object({ id: s.id, key: z.string(), name: z.record(z.string(), z.string()), referencePrefix: z.string(), currency: z.string() });
const attachmentView = z.object({ id: s.id, filename: z.string(), mimeType: z.string(), size: z.number().int(), createdAt: z.string() });
const documentView = z.object({
  id: s.id, reference: z.string(), status, allowedTransitions: z.array(status), editable: z.boolean(),
  type: z.object({ id: s.id, key: z.string(), name: z.record(z.string(), z.string()), referencePrefix: z.string() }),
  date: z.string(),
  client: z.object({ id: z.string().nullable(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable() }),
  comments: z.string(), currency: z.string(),
  items: z.array(z.object({ id: s.id, position: z.number().int(), name: z.string(), description: z.string(), sku: z.string().nullable(), unit: z.string().nullable(), quantity: z.string(), unitPrice: amount, total: amount })),
  subtotal: amount, discountTotal: amount, taxTotal: amount, total: amount,
  attachments: z.array(attachmentView), version: z.number().int(), createdBy: z.string(), createdAt: z.string(), updatedAt: z.string(),
});

const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });

/** Binary routes (PDF, image upload/download) cannot use the JSON contract helper. */
async function binary<T>(request: FastifyRequest, work: (userId: string) => Promise<T>) {
  return withRequestContext(request.id, async () => {
    const user = await principal(request);
    return work(user.id);
  });
}

export async function documentRoutes(app: FastifyInstance) {
  const tag = "Documents";

  contract(app, {
    method: "GET", url: "/organizations/:organizationId/document-types", tag,
    summary: "List active document types and the delivery channels configured for this environment", params: s.orgParams,
    response: z.object({ types: z.array(typeView), channels: z.object({ email: z.enum(["available", "not_configured"]), whatsapp: z.enum(["available", "not_configured"]) }) }),
    run: ({ user, params }) => documentsService.listTypes(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/document-types", tag, status: 201,
    summary: "Create a document type with its human reference prefix", params: s.orgParams,
    body: z.object({
      key: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
      name: localizedName,
      referencePrefix: z.string().regex(/^[A-Z]{2,6}$/),
      currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
    }).strict(),
    response: typeView,
    run: ({ user, params, body }) => documentsService.createType(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/document-clients", tag,
    summary: "Search the organization's reusable clients", params: s.orgParams,
    query: z.object({ q: z.string().max(100).default("") }).strict(),
    response: z.array(z.object({ id: s.id, name: z.string(), email: z.string().nullable(), phone: z.string().nullable() })),
    run: ({ user, params, query }) => documentsService.searchClients(user.id, params.organizationId, query.q),
  });

  contract(app, {
    method: "GET", url: "/organizations/:organizationId/documents", tag,
    summary: "List documents with status, client, date and text filters", params: s.orgParams,
    query: z.object({
      status: status.optional(), typeId: s.id.optional(), clientId: s.id.optional(), q: z.string().max(100).optional(),
      from: z.coerce.date().optional(), to: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25), cursor: s.id.optional(),
    }).strict(),
    response: z.object({
      items: z.array(z.object({ id: s.id, reference: z.string(), status, typeKey: z.string(), clientName: z.string(), date: z.string(), total: amount, currency: z.string(), updatedAt: z.string() })),
      nextCursor: z.string().nullable(),
    }),
    run: ({ user, params, query }) => documentsService.list(user.id, params.organizationId, query),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/documents", tag, status: 201,
    summary: "Create a draft document; the server assigns the human reference and totals", params: s.orgParams, body: documentBody, response: documentView,
    run: ({ user, params, body }) => documentsService.create(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/documents/:documentId", tag,
    summary: "Read one document", params: docParams, response: documentView,
    run: ({ user, params }) => documentsService.get(user.id, params.organizationId, params.documentId),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/documents/:documentId", tag,
    summary: "Replace the content of a draft or ready document (optimistic version check)", params: docParams,
    body: documentBody.omit({ typeId: true }).extend({ expectedVersion: z.number().int().min(1) }).strict(),
    response: documentView,
    run: ({ user, params, body }) => documentsService.update(user.id, params.organizationId, params.documentId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/documents/:documentId/status", tag,
    summary: "Move a document along its workflow", params: docParams, body: z.object({ status }).strict(), response: documentView,
    run: ({ user, params, body }) => documentsService.changeStatus(user.id, params.organizationId, params.documentId, body.status),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/documents/:documentId", tag,
    summary: "Delete a draft document", params: docParams, response: z.object({ id: s.id }),
    run: ({ user, params }) => documentsService.remove(user.id, params.organizationId, params.documentId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/documents/:documentId/events", tag,
    summary: "Read the document history from the audit log", params: docParams,
    response: z.array(z.object({ id: s.id, action: z.string(), actorId: z.string().nullable(), actorName: z.string().nullable(), createdAt: z.string(), metadata: z.record(z.string(), z.unknown()) })),
    run: ({ user, params }) => documentsService.events(user.id, params.organizationId, params.documentId),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/documents/:documentId/attachments/:attachmentId", tag,
    summary: "Remove an attachment from a draft or ready document", params: docParams.extend({ attachmentId: s.id }), response: z.object({ id: s.id }),
    run: ({ user, params }) => documentsService.removeAttachment(user.id, params.organizationId, params.documentId, params.attachmentId),
  });

  const delivery = z.object({ to: z.string().trim().max(254).optional(), message: z.string().max(2000).optional(), language }).strict();
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/documents/:documentId/send/email", tag, rateLimit: 10,
    summary: "Email the PDF to the client (503 EMAIL_NOT_CONFIGURED when SMTP is not configured)", params: docParams,
    body: delivery.extend({ to: z.string().trim().email().max(254).optional(), subject: z.string().trim().max(200).optional() }).strict(),
    response: documentView,
    run: ({ user, params, body }) => documentsService.sendEmail(user.id, params.organizationId, params.documentId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/documents/:documentId/send/whatsapp", tag, rateLimit: 10,
    summary: "Send the PDF through the official WhatsApp Business Cloud API (503 WHATSAPP_NOT_CONFIGURED when it is not configured)", params: docParams,
    body: delivery, response: documentView,
    run: ({ user, params, body }) => documentsService.sendWhatsApp(user.id, params.organizationId, params.documentId, body),
  });

  // --- binary ---------------------------------------------------------------
  app.route({
    method: "GET", url: "/organizations/:organizationId/documents/:documentId/pdf",
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    schema: { tags: [tag], summary: "Download the document as a PDF", security: [{ sessionCookie: [] }], params: json(docParams), querystring: json(z.object({ lang: language }).strict()), response: { 200: { type: "string", format: "binary" } } },
    handler: async (request, reply: FastifyReply) => {
      const params = docParams.parse(request.params);
      const query = z.object({ lang: language }).strict().parse(request.query);
      const file = await binary(request, (userId) => documentsService.pdf(userId, params.organizationId, params.documentId, { language: query.lang, purpose: "DOWNLOAD" }));
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(file.content);
    },
  });

  app.route({
    method: "GET", url: "/organizations/:organizationId/documents/:documentId/attachments/:attachmentId",
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    schema: { tags: [tag], summary: "Read an attachment (image bytes)", security: [{ sessionCookie: [] }], params: json(docParams.extend({ attachmentId: s.id })), response: { 200: { type: "string", format: "binary" } } },
    handler: async (request, reply: FastifyReply) => {
      const params = docParams.extend({ attachmentId: s.id }).parse(request.params);
      const file = await binary(request, (userId) => documentsService.readAttachment(userId, params.organizationId, params.documentId, params.attachmentId));
      return reply
        .header("content-type", file.mimeType)
        .header("content-disposition", `inline; filename="${file.filename.replace(/["\\]/g, "_")}"`)
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(file.data);
    },
  });

  // The raw image parsers are scoped to this plugin so every JSON route keeps its 32 KiB body limit.
  await app.register(async (scope) => {
    scope.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer", bodyLimit: ATTACHMENT_LIMITS.maxBytes + 1024 }, (_request, body, done) => done(null, body));
    scope.route({
      method: "POST", url: "/organizations/:organizationId/documents/:documentId/attachments",
      bodyLimit: ATTACHMENT_LIMITS.maxBytes + 1024,
      config: { rateLimit: { max: 40, timeWindow: "1 minute" } },
      schema: {
        tags: [tag], summary: "Upload one JPEG/PNG/WebP image (raw body, filename in the query); the file signature decides the type",
        security: [{ sessionCookie: [] }], params: json(docParams), querystring: json(z.object({ filename: z.string().trim().min(1).max(200) }).strict()),
        response: { 201: json(attachmentView) },
      },
      handler: async (request, reply: FastifyReply) => {
        const params = docParams.parse(request.params);
        const query = z.object({ filename: z.string().trim().min(1).max(200) }).strict().parse(request.query);
        const created = await binary(request, (userId) => documentsService.addAttachment(userId, params.organizationId, params.documentId, { filename: query.filename, data: request.body as Buffer }));
        return reply.code(201).send(created);
      },
    });
  });
}
