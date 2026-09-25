import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "../../lib/database.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { DomainError, fail } from "../../shared/errors.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorizeNorth, hasNorthCapability, type NorthTarget } from "./authorization.js";
import {
  validateNorthPanelDocument,
  type NorthAssetReferenceValidator,
  type NorthBindingReferenceValidator,
  type NorthPanelDocument,
} from "./content-schema.js";
import { northContentRepository as repo } from "./content-repository.js";
import { cloneNorthPanelDocument } from "./clone-document.js";

type RevisionInput = {
  document: unknown;
  message?: string;
  publishAt?: string;
  unpublishAt?: string;
};

type ReferenceResolvers = {
  validateAssetReference?: NorthAssetReferenceValidator;
  validateBindingReference?: NorthBindingReferenceValidator;
};
let referenceResolvers: Readonly<ReferenceResolvers> = Object.freeze({});

// TASK 8E/data-source infrastructure wires authoritative resolvers once at
// application composition time. Until then, documents carrying those
// references fail closed rather than accepting unverifiable tenant data.
export function configureNorthContentReferenceResolvers(resolvers: ReferenceResolvers) {
  referenceResolvers = Object.freeze({ ...resolvers });
}

async function panelContext(tx: Transaction, organizationId: string, panelId: string) {
  const panel = await repo.panel(tx, organizationId, panelId);
  if (!panel) fail(404, "NOT_FOUND", "Panel not found");
  if (panel.resourceKind !== "CONTENT") fail(403, "SYSTEM_RESOURCE_PROTECTED", "System panel content is implementation-backed");
  const target: NorthTarget = {
    organizationId,
    scope: "PANEL",
    categoryId: panel.subcategory.categoryId,
    subcategoryId: panel.subcategoryId,
    panelId,
  };
  return { panel, target };
}

function assertCurrent(ifMatch: string | undefined, current: { revisionNumber: number; etag: string } | null) {
  if (!current) {
    if (ifMatch && ifMatch !== "*") fail(409, "REVISION_CONFLICT", "Draft does not match the supplied ETag");
    return;
  }
  if (!ifMatch || ifMatch !== current.etag)
    throw new DomainError(409, "REVISION_CONFLICT", "Draft changed since it was loaded", {
      currentRevision: current.revisionNumber,
      currentETag: current.etag,
    });
}

function etagFor(id: string, panelId: string, revisionNumber: number) {
  return `"${createHash("sha256").update(`${id}:${panelId}:${revisionNumber}`).digest("base64url")}"`;
}

function dates(input: RevisionInput) {
  const publishAt = input.publishAt ? new Date(input.publishAt) : undefined;
  const unpublishAt = input.unpublishAt ? new Date(input.unpublishAt) : undefined;
  if ((publishAt && Number.isNaN(publishAt.valueOf())) || (unpublishAt && Number.isNaN(unpublishAt.valueOf())))
    fail(422, "PUBLICATION_WINDOW_INVALID", "Reserved publication dates must be valid timestamps");
  if (publishAt && unpublishAt && unpublishAt <= publishAt)
    fail(422, "PUBLICATION_WINDOW_INVALID", "Unpublish time must follow publish time");
  return { publishAt, unpublishAt };
}

function revisionView(revision: {
  id: string; panelId: string; revisionNumber: number; etag: string; document: Prisma.JsonValue;
  defaultLocale: string; fallbackLocales: Prisma.JsonValue; message: string | null;
  publishAt: Date | null; unpublishAt: Date | null; createdBy: string; createdAt: Date;
}) {
  return {
    ...revision,
    fallbackLocales: revision.fallbackLocales as string[],
    publishAt: revision.publishAt,
    unpublishAt: revision.unpublishAt,
  };
}

async function createRevision(
  tx: Transaction,
  organizationId: string,
  panelId: string,
  userId: string,
  input: RevisionInput,
  sourceDocument?: NorthPanelDocument,
) {
  const document = sourceDocument ?? await validateNorthPanelDocument(input.document, { organizationId, actorId: userId, tx, ...referenceResolvers });
  const maximum = await repo.nextRevisionNumber(tx, panelId);
  const revisionNumber = (maximum._max.revisionNumber ?? 0) + 1;
  const id = randomUUID();
  const revision = await repo.createRevision(tx, {
    id, organizationId, panelId, revisionNumber, etag: etagFor(id, panelId, revisionNumber),
    document, defaultLocale: document.defaultLocale, fallbackLocales: document.fallbackLocales,
    message: input.message, ...dates(input), createdBy: userId,
  });
  await repo.pointDraft(tx, panelId, revision.id);
  await audit.append(tx, {
    actorId: userId, organizationId, action: "REVISION_CREATED", targetType: "NorthPanelRevision", targetId: revision.id,
    metadata: { panelId, revisionNumber },
  });
  return revision;
}

/** Copy the best revision the actor may read into an independent target draft. */
export async function cloneNorthPanelContent(
  tx: Transaction,
  userId: string,
  organizationId: string,
  sourcePanelId: string,
  targetPanelId: string,
) {
  const source = await repo.panel(tx, organizationId, sourcePanelId);
  const target = await repo.panel(tx, organizationId, targetPanelId);
  if (!source || !target) fail(404, "NOT_FOUND", "Panel not found");
  const sourceTarget: NorthTarget = {
    organizationId,
    scope: "PANEL",
    categoryId: source.subcategory.categoryId,
    subcategoryId: source.subcategoryId,
    panelId: sourcePanelId,
  };
  const mayPreview = await hasNorthCapability(tx, userId, "north.panel.preview", sourceTarget);
  const sourceRevision = mayPreview ? (source.draftRevision ?? source.publishedRevision) : source.publishedRevision;
  if (!sourceRevision) return null;
  const validated = await validateNorthPanelDocument(sourceRevision.document, {
    organizationId,
    actorId: userId,
    tx,
    ...referenceResolvers,
  });
  const document = cloneNorthPanelDocument(validated);
  return createRevision(tx, organizationId, targetPanelId, userId, {
    document,
    message: `Cloned from panel ${sourcePanelId}`,
  }, document);
}

export const northContent = {
  draft(userId: string, organizationId: string, panelId: string) {
    return transaction(async (tx) => {
      const { panel, target } = await panelContext(tx, organizationId, panelId);
      await authorizeNorth(tx, userId, "north.panel.preview", target);
      if (!panel.draftRevision) fail(404, "NOT_FOUND", "Draft not found");
      return revisionView(panel.draftRevision);
    });
  },

  saveDraft(userId: string, organizationId: string, panelId: string, ifMatch: string | undefined, input: RevisionInput) {
    return transaction(async (tx) => {
      const { panel, target } = await panelContext(tx, organizationId, panelId);
      await authorizeNorth(tx, userId, "north.panel.update", target);
      assertCurrent(ifMatch, panel.draftRevision);
      const revision = await createRevision(tx, organizationId, panelId, userId, input);
      await audit.append(tx, {
        actorId: userId, organizationId, action: "PANEL_UPDATED", targetType: "NorthPanel", targetId: panelId,
        metadata: { field: "draft", revisionNumber: revision.revisionNumber },
      });
      return revisionView(revision);
    });
  },

  publish(userId: string, organizationId: string, panelId: string, ifMatch: string | undefined) {
    return transaction(async (tx) => {
      const { panel, target } = await panelContext(tx, organizationId, panelId);
      await authorizeNorth(tx, userId, "north.panel.publish", target);
      if (!panel.draftRevision) fail(409, "DRAFT_REQUIRED", "Panel has no draft to publish");
      assertCurrent(ifMatch, panel.draftRevision);
      await validateNorthPanelDocument(panel.draftRevision.document, {
        organizationId,
        actorId: userId,
        tx,
        ...referenceResolvers,
      });
      await repo.publish(tx, panelId, panel.draftRevision.id);
      await audit.append(tx, {
        actorId: userId, organizationId, action: "PANEL_PUBLISHED", targetType: "NorthPanel", targetId: panelId,
        metadata: { revisionId: panel.draftRevision.id, revisionNumber: panel.draftRevision.revisionNumber },
      });
      return revisionView(panel.draftRevision);
    });
  },

  history(userId: string, organizationId: string, panelId: string) {
    return transaction(async (tx) => {
      const { target } = await panelContext(tx, organizationId, panelId);
      await authorizeNorth(tx, userId, "north.panel.preview", target);
      return repo.history(tx, organizationId, panelId);
    });
  },

  revision(userId: string, organizationId: string, panelId: string, revisionId: string) {
    return transaction(async (tx) => {
      const { target } = await panelContext(tx, organizationId, panelId);
      await authorizeNorth(tx, userId, "north.panel.preview", target);
      const revision = await repo.revision(tx, organizationId, panelId, revisionId);
      if (!revision) fail(404, "NOT_FOUND", "Revision not found");
      return revisionView(revision);
    });
  },

  restore(userId: string, organizationId: string, panelId: string, revisionId: string, ifMatch: string | undefined, message?: string) {
    return transaction(async (tx) => {
      const { panel, target } = await panelContext(tx, organizationId, panelId);
      await authorizeNorth(tx, userId, "north.panel.update", target);
      await authorizeNorth(tx, userId, "north.panel.preview", target);
      assertCurrent(ifMatch, panel.draftRevision);
      const source = await repo.revision(tx, organizationId, panelId, revisionId);
      if (!source) fail(404, "NOT_FOUND", "Revision not found");
      const document = await validateNorthPanelDocument(source.document, { organizationId, actorId: userId, tx, ...referenceResolvers });
      const revision = await createRevision(tx, organizationId, panelId, userId, { document, message }, document);
      await audit.append(tx, {
        actorId: userId, organizationId, action: "REVISION_RESTORED", targetType: "NorthPanelRevision", targetId: revision.id,
        metadata: { panelId, sourceRevision: source.revisionNumber, newRevision: revision.revisionNumber },
      });
      return revisionView(revision);
    });
  },

  async publishedForResolve(tx: Transaction, userId: string, organizationId: string, panelId: string, requestedLocale?: string) {
    const { panel, target } = await panelContext(tx, organizationId, panelId);
    if (panel.status !== "PUBLISHED" || !panel.publishedRevision) fail(404, "NOT_FOUND", "Content not found");
    if (!(await hasNorthCapability(tx, userId, "north.content.read", target))) fail(404, "NOT_FOUND", "Content not found");
    const allowedLocales = new Set([panel.publishedRevision.defaultLocale, ...(panel.publishedRevision.fallbackLocales as string[])]);
    const resolvedLocale = requestedLocale && allowedLocales.has(requestedLocale) ? requestedLocale : panel.publishedRevision.defaultLocale;
    return {
      ...revisionView(panel.publishedRevision),
      locale: { requested: requestedLocale ?? null, resolved: resolvedLocale, fallbackChain: [resolvedLocale, ...[...allowedLocales].filter((item) => item !== resolvedLocale)] },
    };
  },
};
