import { randomUUID } from "node:crypto";
import { DomainError, fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { authorizeNorth } from "./authorization.js";
import { assetConfiguration } from "./asset-config.js";
import { validateAssetDeclaration, validateInspectedAsset } from "./asset-policy.js";
import { northAssetRepository as repo } from "./asset-repository.js";
import { UnconfiguredMalwareScanner } from "./malware-scanner.js";
import { objectStorageFromEnvironment } from "./object-storage.js";
function assetView(asset) {
    return {
        id: asset.id,
        organizationId: asset.organizationId,
        ownerId: asset.ownerId,
        filename: asset.filename,
        mime: asset.mime,
        size: Number(asset.size),
        checksum: asset.checksum,
        status: asset.status,
        confirmedAt: asset.confirmedAt,
        deletedAt: asset.deletedAt,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
    };
}
const target = (organizationId) => ({ organizationId, scope: "ORGANIZATION" });
export class NorthAssetService {
    dependencies;
    appendAudit;
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.appendAudit = dependencies.appendAudit ?? auditRepository.append;
    }
    async scoped(tx, userId, organizationId, assetId, capability) {
        const asset = await repo.asset(tx, organizationId, assetId);
        if (!asset)
            fail(404, "NOT_FOUND", "Asset not found");
        await authorizeNorth(tx, userId, capability, target(organizationId));
        return asset;
    }
    async requestUpload(userId, organizationId, input) {
        const declared = validateAssetDeclaration(input, this.dependencies.config);
        await transaction((tx) => authorizeNorth(tx, userId, "north.asset.create", target(organizationId)));
        const id = randomUUID();
        const storageKey = `north-assets/${organizationId}/${id}`;
        const upload = await this.dependencies.storage.signedPut({
            key: storageKey, mime: declared.mime, size: declared.size, checksum: declared.checksum,
            ttlSeconds: this.dependencies.config.uploadUrlTtlSeconds,
        });
        const asset = await transaction(async (tx) => {
            await authorizeNorth(tx, userId, "north.asset.create", target(organizationId));
            const organization = await repo.organization(tx, organizationId);
            if (!organization)
                fail(404, "NOT_FOUND", "Organization not found");
            const size = BigInt(declared.size);
            if (organization.storageUsedBytes + organization.storageReservedBytes + size > organization.storageLimitBytes)
                fail(409, "QUOTA_EXCEEDED", "Organization storage quota is exceeded");
            await repo.reserve(tx, organizationId, size);
            const created = await repo.create(tx, {
                id, organizationId, ownerId: userId, filename: declared.filename, mime: declared.mime,
                size, checksum: declared.checksum, storageKey,
            });
            await this.appendAudit(tx, {
                actorId: userId, organizationId, action: "ASSET_CREATED", targetType: "NorthAsset", targetId: id,
                metadata: { mime: declared.mime, size: declared.size, status: "UPLOADING" },
            });
            return created;
        });
        return { asset: assetView(asset), upload };
    }
    async terminal(userId, organizationId, assetId, status, code) {
        const asset = await transaction(async (tx) => {
            const current = await this.scoped(tx, userId, organizationId, assetId, "north.asset.create");
            if (current.deletedAt)
                fail(404, "NOT_FOUND", "Asset not found");
            if (current.status === "UPLOADING" || current.status === "PROCESSING") {
                await repo.releaseReservation(tx, organizationId, current.size);
                const updated = await repo.status(tx, current.id, status);
                await this.appendAudit(tx, {
                    actorId: userId, organizationId, action: status === "QUARANTINED" ? "ASSET_QUARANTINED" : "ASSET_REJECTED",
                    targetType: "NorthAsset", targetId: current.id, metadata: { reason: code },
                });
                return updated;
            }
            return current;
        });
        return asset;
    }
    async confirm(userId, organizationId, assetId) {
        const asset = await transaction(async (tx) => {
            const current = await repo.asset(tx, organizationId, assetId);
            if (!current)
                fail(404, "NOT_FOUND", "Asset not found");
            await authorizeNorth(tx, userId, "north.asset.create", target(organizationId));
            if (current.deletedAt)
                fail(404, "NOT_FOUND", "Asset not found");
            if (current.status === "READY")
                return current;
            if (current.status === "REJECTED" || current.status === "QUARANTINED")
                fail(409, "ASSET_NOT_PROCESSABLE", "Asset is not processable");
            if (current.status === "UPLOADING")
                return repo.status(tx, current.id, "PROCESSING");
            return current;
        });
        if (asset.status === "READY")
            return assetView(asset);
        try {
            const inspected = await this.dependencies.storage.inspect(asset.storageKey);
            validateInspectedAsset(asset, inspected);
        }
        catch (error) {
            if (error instanceof DomainError && error.statusCode === 422) {
                await this.terminal(userId, organizationId, assetId, "REJECTED", error.code);
                await this.dependencies.storage.delete(asset.storageKey).catch(() => undefined);
            }
            throw error;
        }
        const verdict = await this.dependencies.scanner.scan({
            storageKey: asset.storageKey, mime: asset.mime, size: Number(asset.size), checksum: asset.checksum,
        });
        if (verdict !== "APPROVED") {
            const status = verdict === "QUARANTINED" ? "QUARANTINED" : "REJECTED";
            const code = verdict === "QUARANTINED" ? "ASSET_QUARANTINED" : "MALWARE_REJECTED";
            await this.terminal(userId, organizationId, assetId, status, code);
            if (status === "REJECTED")
                await this.dependencies.storage.delete(asset.storageKey).catch(() => undefined);
            fail(422, code, status === "QUARANTINED" ? "Asset was quarantined by the scanner" : "Asset was rejected by the scanner");
        }
        const ready = await transaction(async (tx) => {
            const current = await repo.asset(tx, organizationId, assetId);
            if (!current)
                fail(404, "NOT_FOUND", "Asset not found");
            await authorizeNorth(tx, userId, "north.asset.create", target(organizationId));
            if (current.status === "READY")
                return current;
            if (current.status !== "PROCESSING" || current.deletedAt)
                fail(409, "ASSET_NOT_PROCESSABLE", "Asset is not processable");
            await repo.commitReservation(tx, organizationId, current.size);
            const updated = await repo.status(tx, current.id, "READY", new Date());
            await this.appendAudit(tx, {
                actorId: userId, organizationId, action: "ASSET_READY", targetType: "NorthAsset", targetId: current.id,
                metadata: { mime: current.mime, size: Number(current.size) },
            });
            return updated;
        });
        return assetView(ready);
    }
    async signedRead(userId, organizationId, assetId) {
        const asset = await transaction(async (tx) => {
            const current = await this.scoped(tx, userId, organizationId, assetId, "north.asset.read");
            if (current.deletedAt || current.status !== "READY")
                fail(404, "NOT_FOUND", "Asset not found");
            return current;
        });
        const download = await this.dependencies.storage.signedGet({
            key: asset.storageKey, filename: asset.filename, mime: asset.mime,
            ttlSeconds: this.dependencies.config.readUrlTtlSeconds,
        });
        return { asset: assetView(asset), download };
    }
    async delete(userId, organizationId, assetId) {
        const asset = await transaction(async (tx) => {
            const current = await this.scoped(tx, userId, organizationId, assetId, "north.asset.delete");
            if (!current.deletedAt) {
                if (current.status === "READY")
                    await repo.releaseUsed(tx, organizationId, current.size);
                else if (current.status === "UPLOADING" || current.status === "PROCESSING")
                    await repo.releaseReservation(tx, organizationId, current.size);
                await repo.softDelete(tx, current.id, new Date());
                await this.appendAudit(tx, {
                    actorId: userId, organizationId, action: "ASSET_DELETED", targetType: "NorthAsset", targetId: current.id,
                    metadata: { objectDeletion: "REQUESTED" },
                });
            }
            return current;
        });
        await this.dependencies.storage.delete(asset.storageKey);
        return null;
    }
    async validateReference(userId, organizationId, assetId, existingTransaction) {
        const validate = async (tx) => {
            await authorizeNorth(tx, userId, "north.asset.read", target(organizationId));
            return Boolean(await repo.readyReference(tx, organizationId, assetId));
        };
        return existingTransaction ? validate(existingTransaction) : transaction(validate);
    }
}
let configured = new NorthAssetService({
    storage: objectStorageFromEnvironment(), scanner: new UnconfiguredMalwareScanner(), config: assetConfiguration(),
});
export function configureNorthAssetService(service) { configured = service; }
export const northAssets = {
    requestUpload: (...args) => configured.requestUpload(...args),
    confirm: (...args) => configured.confirm(...args),
    signedRead: (...args) => configured.signedRead(...args),
    delete: (...args) => configured.delete(...args),
    validateReference: (...args) => configured.validateReference(...args),
};
