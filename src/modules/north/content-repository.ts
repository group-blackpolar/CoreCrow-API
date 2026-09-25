import { Prisma } from "../../lib/database.js";
import type { Transaction } from "../../shared/transaction.js";
import type { NorthPanelDocument } from "./content-schema.js";

export const northContentRepository = {
  panel(tx: Transaction, organizationId: string, panelId: string) {
    return tx.northPanel.findFirst({
      where: { id: panelId, organizationId },
      include: { subcategory: true, draftRevision: true, publishedRevision: true },
    });
  },
  revision(tx: Transaction, organizationId: string, panelId: string, revisionId: string) {
    return tx.northPanelRevision.findFirst({ where: { id: revisionId, panelId, organizationId } });
  },
  nextRevisionNumber(tx: Transaction, panelId: string) {
    return tx.northPanelRevision.aggregate({ where: { panelId }, _max: { revisionNumber: true } });
  },
  createRevision(tx: Transaction, input: {
    id: string;
    organizationId: string;
    panelId: string;
    revisionNumber: number;
    etag: string;
    document: NorthPanelDocument;
    defaultLocale: string;
    fallbackLocales: string[];
    message?: string;
    publishAt?: Date;
    unpublishAt?: Date;
    createdBy: string;
  }) {
    return tx.northPanelRevision.create({
      data: {
        ...input,
        document: input.document as unknown as Prisma.InputJsonValue,
        fallbackLocales: input.fallbackLocales,
      },
    });
  },
  pointDraft(tx: Transaction, panelId: string, revisionId: string) {
    return tx.northPanel.update({ where: { id: panelId }, data: { draftRevisionId: revisionId } });
  },
  publish(tx: Transaction, panelId: string, revisionId: string) {
    return tx.northPanel.update({
      where: { id: panelId },
      data: { publishedRevisionId: revisionId, draftRevisionId: revisionId, status: "PUBLISHED" },
    });
  },
  history(tx: Transaction, organizationId: string, panelId: string) {
    return tx.northPanelRevision.findMany({
      where: { organizationId, panelId },
      orderBy: { revisionNumber: "desc" },
      select: {
        id: true, panelId: true, revisionNumber: true, etag: true, defaultLocale: true,
        fallbackLocales: true, message: true, publishAt: true, unpublishAt: true,
        createdBy: true, createdAt: true,
      },
      take: 100,
    });
  },
};
