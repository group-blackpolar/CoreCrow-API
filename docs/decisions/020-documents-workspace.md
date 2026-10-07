# Documents: reusable workflow records (forms, quotes, orders)

- Status: Accepted
- Date: 2026-10-06
- Scope: CORECROW documents module, NORTH `document_workspace` component

## Decision

A **document** is a tenant-scoped, persistent record with a human reference
(`SEM-000001`), a workflow status, exact decimal line items, comments, image
attachments, a PDF rendering and an audit history. Documents are generic: a
`DocumentType` (key, localized name, reference prefix, currency, reserved
`config`) is configuration, a `Document` is an instance. Seminsa is only a
provisioning input (`provision-documents`); no code branches on an organization.

Separated concepts: Form Type (`DocumentType`), Form Instance (`Document`),
Fields/Data (`data` JSON, reserved), Items (`DocumentItem`), Attachments
(`DocumentAttachment` + `DocumentAttachmentBlob`), Workflow (`status.ts`),
Delivery (`delivery.ts`). No form builder is introduced.

### Authorization and tenancy
Seven registered organization permissions: `documents.read|create|update|delete|
download|send|manage`. Defaults: OWNER/ADMIN all; MEMBER read, create, update,
download; VIEWER read, download; BILLING_ADMIN none (grantable). Every operation
derives the organization from authoritative membership, is default-deny, and
uses composite `(id, organizationId)` foreign keys so cross-tenant references
are impossible at the database level.

### Workflow
`DRAFT -> READY -> SENT -> COMPLETED`, `CANCELLED` from any non-terminal state,
`READY -> DRAFT` to reopen. `COMPLETED` and `CANCELLED` are terminal. Content
changes only while DRAFT or READY and use an optimistic `version`. Marking SENT
requires `documents.send`; a successful email/WhatsApp delivery moves READY to
SENT. Only drafts can be deleted.

### Reference numbering
Per-type counter row incremented inside the creating serializable transaction:
unique and monotonic, with no reuse after a delete. Concurrent creators retry
with jitter (`transaction(..., { retries })`).

### Money
Strings in the API, `NUMERIC` in PostgreSQL, `decimal.js` arithmetic, half-up to
cents per line. Quantity <= 9999.999, price <= 9,999,999.99, at most 100 items.
Discount and tax columns exist (zero) for later; `total = subtotal - discount + tax`.

### Clients
`DocumentClient` is reusable (unique by lower-cased email per organization) and
searchable; each document stores a frozen snapshot so a later client edit never
rewrites an issued document. No CRM is built.

### Attachments
Object storage (S3 + malware scanner) is not provisioned in production, so
images are stored in `DocumentAttachmentBlob`, separate from the main record and
never in list queries. Accepted types: JPEG, PNG and WebP (jpg/jpeg, png, webp), decided by file
signature (the declared type is not trusted) and required to decode (`sharp`, 40 MP limit). WebP is
converted to PNG only to embed it in the PDF (PDFKit supports JPEG/PNG); the original is stored and
served unchanged. Limits: 5 MiB each, 10 images and 25 MiB per document.
`DocumentAttachment.storage`
is the provider seam: moving to object storage later does not change the API.
This is a deliberate exception to "no binaries in PostgreSQL", scoped by those limits.

### PDF
`pdfkit`, A4, generated on demand from data by a reusable template (never a UI
capture); paginated, with an images page. It states that it is not a fiscal invoice.

### Delivery
- **Email** reuses the existing SMTP transport; the PDF is attached. Without
  SMTP the API answers `503 EMAIL_NOT_CONFIGURED`.
- **WhatsApp** uses only Meta's official Cloud API (media upload, then a template
  or document message). Credentials exist only in server environment variables
  (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, optional
  `WHATSAPP_TEMPLATE_NAME`). Without them: `503 WHATSAPP_NOT_CONFIGURED`.
  Business-initiated messages outside the 24 h window require an approved template.
- Neither channel ever simulates success. Every outcome is audited with a masked recipient.

### History
Events are `AuditLog` rows (`targetType = Document`): created, updated, status
changed, cancelled, PDF generated/downloaded, email/WhatsApp sent or failed,
attachment added/removed, deleted. There is no parallel audit store.

### NORTH
The panel component `document_workspace { typeKey }` renders the list, editor,
detail, PDF and delivery UI for members only (never in the public showcase).

## Consequences
- Permission enums in the OpenAPI grow (additive).
- Production needs a one-time `provision-documents-organization` run per organization.
- Object storage, a malware scanner, and a verified WhatsApp Business account are
  external prerequisites that this decision deliberately does not fake.
