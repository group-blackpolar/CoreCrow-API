export const northAssetRepository = {
    organization(tx, organizationId) {
        return tx.organization.findUnique({ where: { id: organizationId } });
    },
    asset(tx, organizationId, assetId) {
        return tx.northAsset.findFirst({ where: { id: assetId, organizationId } });
    },
    create(tx, input) {
        return tx.northAsset.create({ data: input });
    },
    reserve(tx, organizationId, size) {
        return tx.organization.update({
            where: { id: organizationId },
            data: { storageReservedBytes: { increment: size } },
        });
    },
    releaseReservation(tx, organizationId, size) {
        return tx.organization.update({
            where: { id: organizationId },
            data: { storageReservedBytes: { decrement: size } },
        });
    },
    commitReservation(tx, organizationId, size) {
        return tx.organization.update({
            where: { id: organizationId },
            data: { storageReservedBytes: { decrement: size }, storageUsedBytes: { increment: size } },
        });
    },
    releaseUsed(tx, organizationId, size) {
        return tx.organization.update({
            where: { id: organizationId },
            data: { storageUsedBytes: { decrement: size } },
        });
    },
    status(tx, id, status, confirmedAt) {
        return tx.northAsset.update({ where: { id }, data: { status, ...(confirmedAt ? { confirmedAt } : {}) } });
    },
    softDelete(tx, id, deletedAt) {
        return tx.northAsset.update({ where: { id }, data: { deletedAt } });
    },
    readyReference(tx, organizationId, assetId) {
        return tx.northAsset.findFirst({
            where: { id: assetId, organizationId, status: "READY", deletedAt: null },
            select: { id: true },
        });
    },
};
