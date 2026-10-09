import { randomUUID } from "node:crypto";
import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { assetConfiguration, type AssetConfiguration } from "../north/asset-config.js";
import { validateInspectedAsset } from "../north/asset-policy.js";
import { malwareScannerFromEnvironment, type MalwareScanner } from "../north/malware-scanner.js";
import { objectStorageFromEnvironment, type ObjectStorage } from "../north/object-storage.js";
import { AVATAR_MAX_BYTES, validateAvatarDeclaration } from "./avatar-policy.js";

export type AvatarDependencies = { storage: ObjectStorage; scanner: MalwareScanner; config: AssetConfiguration };

const view = (row: { id: string; mime: string; size: number; status: string; confirmedAt: Date | null; createdAt: Date }) => ({
  id: row.id, mime: row.mime, size: row.size, status: row.status, confirmedAt: row.confirmedAt, createdAt: row.createdAt,
});

/**
 * Personal avatars. Every operation acts on the authenticated user only: no route carries a user id, so knowing
 * an id grants nothing. Bytes are private; reads are short-lived signed URLs issued to the owner.
 * Same storage, scanner and byte-level validation as NorthAsset, but user-scoped (a person is not an organization).
 */
export class UserAvatarService {
  constructor(private readonly deps: AvatarDependencies) {}

  async requestUpload(userId: string, input: { mime: string; size: number; checksum: string }) {
    const declared = validateAvatarDeclaration(input, this.deps.config);
    const id = randomUUID();
    const storageKey = `user-avatars/${userId}/${id}`;
    const upload = await this.deps.storage.signedPut({
      key: storageKey, mime: declared.mime, size: declared.size, checksum: declared.checksum, ttlSeconds: this.deps.config.uploadUrlTtlSeconds,
    });
    // Abandoned uploads (never confirmed) are swept here, so a user cannot accumulate orphan rows or objects.
    const staleBefore = new Date(Date.now() - 2 * this.deps.config.uploadUrlTtlSeconds * 1000);
    const { row, stale } = await transaction(async (tx) => {
      const stale = await tx.userAvatar.findMany({
        where: { userId, deletedAt: null, status: { in: ["UPLOADING", "PROCESSING"] }, createdAt: { lt: staleBefore } },
        select: { id: true, storageKey: true },
      });
      if (stale.length) await tx.userAvatar.updateMany({ where: { id: { in: stale.map((item) => item.id) } }, data: { deletedAt: new Date() } });
      const row = await tx.userAvatar.create({
        data: { id, userId, mime: declared.mime, size: declared.size, checksum: declared.checksum, storageKey },
      });
      await auditRepository.append(tx, { actorId: userId, action: "AVATAR_UPLOAD_REQUESTED", targetType: "UserAvatar", targetId: id, metadata: { mime: declared.mime, size: declared.size } });
      return { row, stale };
    });
    await Promise.all(stale.map((item) => this.deps.storage.delete(item.storageKey).catch(() => undefined)));
    return { avatar: view(row), upload };
  }

  async confirm(userId: string, avatarId: string) {
    const row = await transaction(async (tx) => {
      const current = await tx.userAvatar.findFirst({ where: { id: avatarId, userId, deletedAt: null } });
      if (!current) fail(404, "NOT_FOUND", "Avatar not found");
      if (current.status === "REJECTED" || current.status === "QUARANTINED") fail(409, "ASSET_NOT_PROCESSABLE", "Avatar is not processable");
      if (current.status === "UPLOADING") return tx.userAvatar.update({ where: { id: current.id }, data: { status: "PROCESSING" } });
      return current;
    });
    if (row.status === "READY") return view(row);

    const reject = async (status: "REJECTED" | "QUARANTINED") => {
      await transaction((tx) => tx.userAvatar.update({ where: { id: row.id }, data: { status } }));
      await this.deps.storage.delete(row.storageKey).catch(() => undefined);
    };
    let storageVersionId: string;
    try {
      const inspected = await this.deps.storage.inspect(row.storageKey);
      validateInspectedAsset({ mime: row.mime, size: BigInt(row.size), checksum: row.checksum }, inspected);
      // Without a provider version the scanned bytes could be swapped afterwards: fail closed (retryable, not a rejection).
      if (!inspected.versionId || inspected.versionId === "null")
        fail(503, "ASSET_STORAGE_IMMUTABILITY_UNAVAILABLE", "Avatar storage must have object versioning enabled");
      storageVersionId = inspected.versionId;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 422) await reject("REJECTED");
      throw error;
    }
    const verdict = await this.deps.scanner.scan({ storageKey: row.storageKey, storageVersionId, mime: row.mime, size: row.size, checksum: row.checksum });
    if (verdict !== "APPROVED") {
      await reject(verdict === "QUARANTINED" ? "QUARANTINED" : "REJECTED");
      fail(422, verdict === "QUARANTINED" ? "ASSET_QUARANTINED" : "MALWARE_REJECTED", "Avatar was rejected by the scanner");
    }

    // Promote the new avatar and retire the previous one in one transaction; the partial unique index backs the invariant.
    const { ready, replaced } = await transaction(async (tx) => {
      const current = await tx.userAvatar.findFirst({ where: { id: row.id, userId, deletedAt: null } });
      if (!current || current.status !== "PROCESSING") fail(409, "ASSET_NOT_PROCESSABLE", "Avatar is not processable");
      const replaced = await tx.userAvatar.findMany({ where: { userId, status: "READY", deletedAt: null, id: { not: row.id } }, select: { id: true, storageKey: true } });
      if (replaced.length) await tx.userAvatar.updateMany({ where: { id: { in: replaced.map((item) => item.id) } }, data: { deletedAt: new Date() } });
      const ready = await tx.userAvatar.update({ where: { id: row.id }, data: { status: "READY", confirmedAt: new Date(), storageVersionId } });
      await auditRepository.append(tx, { actorId: userId, action: "AVATAR_READY", targetType: "UserAvatar", targetId: row.id, metadata: { replaced: replaced.length } });
      return { ready, replaced };
    });
    // Object deletion runs after the commit: a failure leaves an unreferenced object, never a dangling reference.
    await Promise.all(replaced.map((item) => this.deps.storage.delete(item.storageKey).catch(() => undefined)));
    return view(ready);
  }

  async readOwn(userId: string) {
    const row = await transaction((tx) => tx.userAvatar.findFirst({ where: { userId, status: "READY", deletedAt: null } }));
    if (!row) return { avatar: null, download: null };
    const download = await this.deps.storage.signedGet({ key: row.storageKey, versionId: row.storageVersionId ?? undefined, filename: "avatar", mime: row.mime, ttlSeconds: this.deps.config.readUrlTtlSeconds });
    return { avatar: view(row), download };
  }

  async deleteOwn(userId: string) {
    const rows = await transaction(async (tx) => {
      const rows = await tx.userAvatar.findMany({ where: { userId, deletedAt: null }, select: { id: true, storageKey: true } });
      if (rows.length) {
        await tx.userAvatar.updateMany({ where: { id: { in: rows.map((item) => item.id) } }, data: { deletedAt: new Date() } });
        await auditRepository.append(tx, { actorId: userId, action: "AVATAR_DELETED", targetType: "UserAvatar", targetId: rows[0]!.id });
      }
      return rows;
    });
    await Promise.all(rows.map((item) => this.deps.storage.delete(item.storageKey).catch(() => undefined)));
    return null;
  }
}

const defaultStorage = objectStorageFromEnvironment();
const defaultConfiguration = assetConfiguration();
let configured = new UserAvatarService({
  storage: defaultStorage,
  scanner: malwareScannerFromEnvironment(defaultStorage, { maximumBytes: AVATAR_MAX_BYTES }),
  config: defaultConfiguration,
});
export function configureUserAvatarService(service: UserAvatarService) { configured = service; }
export const userAvatars = {
  requestUpload: (...args: Parameters<UserAvatarService["requestUpload"]>) => configured.requestUpload(...args),
  confirm: (...args: Parameters<UserAvatarService["confirm"]>) => configured.confirm(...args),
  readOwn: (...args: Parameters<UserAvatarService["readOwn"]>) => configured.readOwn(...args),
  deleteOwn: (...args: Parameters<UserAvatarService["deleteOwn"]>) => configured.deleteOwn(...args),
};
