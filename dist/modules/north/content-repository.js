export const northContentRepository = {
    panel(tx, organizationId, panelId) {
        return tx.northPanel.findFirst({
            where: { id: panelId, organizationId },
            include: { subcategory: true, draftRevision: true, publishedRevision: true },
        });
    },
    revision(tx, organizationId, panelId, revisionId) {
        return tx.northPanelRevision.findFirst({ where: { id: revisionId, panelId, organizationId } });
    },
    nextRevisionNumber(tx, panelId) {
        return tx.northPanelRevision.aggregate({ where: { panelId }, _max: { revisionNumber: true } });
    },
    createRevision(tx, input) {
        return tx.northPanelRevision.create({
            data: {
                ...input,
                document: input.document,
                fallbackLocales: input.fallbackLocales,
            },
        });
    },
    pointDraft(tx, panelId, revisionId) {
        return tx.northPanel.update({ where: { id: panelId }, data: { draftRevisionId: revisionId } });
    },
    publish(tx, panelId, revisionId) {
        return tx.northPanel.update({
            where: { id: panelId },
            data: { publishedRevisionId: revisionId, draftRevisionId: revisionId, status: "PUBLISHED" },
        });
    },
    history(tx, organizationId, panelId) {
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
