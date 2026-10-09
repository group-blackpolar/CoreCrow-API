import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, prisma } from "./lib/database.js";
import { auditRepository as audit } from "./modules/audit/repository.js";
import { bootstrapNorthOrganization } from "./modules/north/service.js";
import { validateNorthPanelDocument } from "./modules/north/content-schema.js";
import { workspaceDocument } from "./modules/documents/workspace-panel.js";

/**
 * Generic provisioning of a document workspace for an organization: the
 * organization (when missing), a document type with its reference prefix, and a
 * published panel that hosts the reusable `document_workspace` component.
 * Seminsa is only configuration (slug, names, prefix); nothing here is tenant specific.
 *
 *   node dist/provision-documents.js --email owner@example.com --organization-slug seminsa \
 *     --organization-name Seminsa --prefix SEM [--type-key forma] [--type-name-es Forma] [--type-name-en Form] \
 *     [--category-name-es Formas] [--category-name-en Forms] [--currency USD]
 *   node dist/provision-documents.js --validate-only
 *
 * Idempotent: running it again changes nothing that already matches.
 */
const localized = (es: string, en: string) => ({ es, en });

const optionsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  organizationSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  organizationName: z.string().trim().min(2).max(120),
  prefix: z.string().regex(/^[A-Z]{2,6}$/),
  typeKey: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).default("forma"),
  typeNameEs: z.string().trim().min(1).max(120).default("Forma"),
  typeNameEn: z.string().trim().min(1).max(120).default("Form"),
  categoryNameEs: z.string().trim().min(1).max(120).default("Formas"),
  categoryNameEn: z.string().trim().min(1).max(120).default("Forms"),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
});
type Options = z.infer<typeof optionsSchema>;

function parseArguments(command: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    if (!token.startsWith("--")) throw new Error("Unexpected argument");
    const separator = token.indexOf("=");
    if (separator > 2) { values.set(token.slice(2, separator), token.slice(separator + 1)); continue; }
    const value = command[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    values.set(token.slice(2), value);
    index += 1;
  }
  const get = (key: string) => values.get(key);
  return optionsSchema.parse({
    email: get("email"), organizationSlug: get("organization-slug"), organizationName: get("organization-name"), prefix: get("prefix"),
    typeKey: get("type-key"), typeNameEs: get("type-name-es"), typeNameEn: get("type-name-en"),
    categoryNameEs: get("category-name-es"), categoryNameEn: get("category-name-en"), currency: get("currency"),
  });
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const etagFor = (id: string, panelId: string, revisionNumber: number) => `"${createHash("sha256").update(`${id}:${panelId}:${revisionNumber}`).digest("base64url")}"`;

async function provision(options: Options) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email: options.email } });
    if (!user || user.status !== "ACTIVE" || !user.emailVerified) throw new Error("The owner account must exist, be active and have a verified email");

    let organization = await tx.organization.findUnique({ where: { slug: options.organizationSlug } });
    let created = false;
    if (!organization) {
      organization = await tx.organization.create({ data: { slug: options.organizationSlug, name: options.organizationName, billingProfile: { create: {} } } });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: "OWNER" } });
      created = true;
    } else {
      const membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: organization.id, userId: user.id } } });
      if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) throw new Error("The account must be an OWNER or ADMIN of the existing organization");
    }
    const organizationId = organization.id;
    await bootstrapNorthOrganization(tx, organizationId);

    // Document type (+ its gap-free counter).
    const clash = await tx.documentType.findFirst({ where: { organizationId, referencePrefix: options.prefix, NOT: { key: options.typeKey } } });
    if (clash) throw new Error(`The prefix ${options.prefix} is already used by another document type`);
    const type = await tx.documentType.upsert({
      where: { organizationId_key: { organizationId, key: options.typeKey } },
      update: { name: localized(options.typeNameEs, options.typeNameEn), status: "ACTIVE" },
      create: { organizationId, key: options.typeKey, name: localized(options.typeNameEs, options.typeNameEn), referencePrefix: options.prefix, currency: options.currency, createdBy: user.id },
    });
    await tx.documentSequence.upsert({ where: { typeId: type.id }, update: {}, create: { typeId: type.id, organizationId } });

    // Navigation: category -> subcategory -> published panel hosting the workspace.
    const categoryName = localized(options.categoryNameEs, options.categoryNameEn);
    const category = await tx.northCategory.upsert({
      where: { organizationId_slug: { organizationId, slug: "formas" } },
      update: { name: categoryName, icon: "FileText", status: "ACTIVE", navigationHidden: false },
      create: { organizationId, scope: "ORGANIZATION", resourceKind: "CONTENT", categoryClass: "CUSTOM", name: categoryName, icon: "FileText", slug: "formas", order: 0 },
    });
    const subcategory = await tx.northSubcategory.upsert({
      where: { categoryId_slug: { categoryId: category.id, slug: "formas" } },
      update: { name: categoryName, status: "ACTIVE", navigationHidden: false },
      create: { organizationId, categoryId: category.id, resourceKind: "CONTENT", name: categoryName, slug: "formas", order: 0 },
    });
    const panel = await tx.northPanel.upsert({
      where: { subcategoryId_slug: { subcategoryId: subcategory.id, slug: "formas" } },
      update: { name: categoryName, navigationHidden: false, audienceType: "ALL_MEMBERS" },
      create: { organizationId, subcategoryId: subcategory.id, resourceKind: "CONTENT", name: categoryName, slug: "formas", order: 0, audienceType: "ALL_MEMBERS" },
    });
    const document = await validateNorthPanelDocument(workspaceDocument(options.typeKey, categoryName), { organizationId, actorId: user.id, tx, panelId: panel.id, validateBindingReference: async () => false });
    const published = await tx.northPanelRevision.findFirst({ where: { id: panel.publishedRevisionId ?? "", panelId: panel.id, organizationId } });
    if (!published || !sameJson(published.document, document)) {
      const maximum = await tx.northPanelRevision.aggregate({ where: { panelId: panel.id }, _max: { revisionNumber: true } });
      const revisionNumber = (maximum._max.revisionNumber ?? 0) + 1;
      const id = randomUUID();
      const revision = await tx.northPanelRevision.create({ data: {
        id, organizationId, panelId: panel.id, revisionNumber, etag: etagFor(id, panel.id, revisionNumber), document: document as unknown as Prisma.InputJsonValue,
        defaultLocale: document.defaultLocale, fallbackLocales: document.fallbackLocales, message: "Document workspace provisioned", createdBy: user.id,
      } });
      await tx.northPanel.update({ where: { id: panel.id }, data: { status: "PUBLISHED", draftRevisionId: revision.id, publishedRevisionId: revision.id } });
    } else if (panel.status !== "PUBLISHED") {
      await tx.northPanel.update({ where: { id: panel.id }, data: { status: "PUBLISHED", draftRevisionId: published.id, publishedRevisionId: published.id } });
    }
    // The empty system Home would otherwise be the landing view; the workspace is the organization's home.
    await tx.northCategory.updateMany({ where: { organizationId, slug: "home", resourceKind: "SYSTEM" }, data: { navigationHidden: true } });
    await tx.organization.update({ where: { id: organizationId }, data: { homePanelId: panel.id } });
    await audit.append(tx, { actorId: user.id, organizationId, action: "DOCUMENTS_WORKSPACE_PROVISIONED", targetType: "DocumentType", targetId: type.id, metadata: { key: type.key, prefix: type.referencePrefix, organizationCreated: created } });
    return { organizationId, organizationCreated: created, typeId: type.id, typeKey: type.key, prefix: type.referencePrefix, panelId: panel.id };
  }, { isolationLevel: "Serializable", timeout: 60_000, maxWait: 15_000 });
}

async function main() {
  const command = process.argv.slice(2);
  if (command.length === 1 && command[0] === "--validate-only") {
    await validateNorthPanelDocument(workspaceDocument("forma", localized("Formas", "Forms")), { organizationId: "o", actorId: "u", panelId: "p", validateBindingReference: async () => false });
    process.stdout.write(`${JSON.stringify({ status: "valid" })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await provision(parseArguments(command)))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Provisioning failed"}\n`);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
