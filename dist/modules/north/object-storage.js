import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "../../shared/errors.js";
const expiresAt = (seconds) => new Date(Date.now() + seconds * 1_000);
const hexToBase64 = (hex) => Buffer.from(hex, "hex").toString("base64");
const base64ToHex = (base64) => Buffer.from(base64, "base64").toString("hex");
export class S3ObjectStorage {
    client;
    bucket;
    constructor(client, bucket) {
        this.client = client;
        this.bucket = bucket;
    }
    async signedPut(input) {
        const checksum = hexToBase64(input.checksum);
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            ContentType: input.mime,
            ContentLength: input.size,
            ChecksumSHA256: checksum,
        });
        return {
            url: await getSignedUrl(this.client, command, { expiresIn: input.ttlSeconds }),
            method: "PUT",
            headers: {
                "content-type": input.mime,
                "content-length": String(input.size),
                "x-amz-checksum-sha256": checksum,
            },
            expiresAt: expiresAt(input.ttlSeconds),
        };
    }
    async signedGet(input) {
        const safeFilename = input.filename.replace(/["\\\r\n]/g, "_");
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            ResponseContentType: input.mime,
            ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
        });
        return {
            url: await getSignedUrl(this.client, command, { expiresIn: input.ttlSeconds }),
            method: "GET",
            headers: {},
            expiresAt: expiresAt(input.ttlSeconds),
        };
    }
    async inspect(key) {
        const [head, prefix] = await Promise.all([
            this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" })),
            this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: "bytes=0-63" })),
        ]);
        if (head.ContentLength === undefined || !Number.isSafeInteger(head.ContentLength) || !prefix.Body)
            throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object metadata could not be verified");
        return {
            size: head.ContentLength,
            mime: head.ContentType,
            checksum: head.ChecksumSHA256 ? base64ToHex(head.ChecksumSHA256) : undefined,
            prefix: await prefix.Body.transformToByteArray(),
        };
    }
    async delete(key) {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }
}
class UnavailableObjectStorage {
    unavailable() {
        throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Asset object storage is not configured");
    }
    signedPut() { return Promise.reject(this.unavailable()); }
    signedGet() { return Promise.reject(this.unavailable()); }
    inspect() { return Promise.reject(this.unavailable()); }
    delete() { return Promise.reject(this.unavailable()); }
}
export function objectStorageFromEnvironment() {
    const bucket = process.env.NORTH_ASSET_S3_BUCKET;
    const region = process.env.NORTH_ASSET_S3_REGION;
    if (!bucket || !region)
        return new UnavailableObjectStorage();
    return new S3ObjectStorage(new S3Client({
        region,
        ...(process.env.NORTH_ASSET_S3_ENDPOINT ? { endpoint: process.env.NORTH_ASSET_S3_ENDPOINT } : {}),
        forcePathStyle: process.env.NORTH_ASSET_S3_FORCE_PATH_STYLE === "true",
    }), bucket);
}
export class FakeObjectStorage {
    objects = new Map();
    failDelete = false;
    put(key, value) { this.objects.set(key, value); }
    async signedPut(input) {
        return { url: `https://storage.invalid/upload/${encodeURIComponent(input.key)}`, method: "PUT", headers: { "content-type": input.mime, "content-length": String(input.size), "x-content-sha256": input.checksum }, expiresAt: expiresAt(input.ttlSeconds) };
    }
    async signedGet(input) {
        if (!this.objects.has(input.key))
            throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object is unavailable");
        return { url: `https://storage.invalid/read/${encodeURIComponent(input.key)}`, method: "GET", headers: {}, expiresAt: expiresAt(input.ttlSeconds) };
    }
    async inspect(key) {
        const object = this.objects.get(key);
        if (!object)
            throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object is unavailable");
        return { size: object.bytes.byteLength, mime: object.mime, checksum: object.checksum, prefix: object.bytes.slice(0, 64) };
    }
    async delete(key) {
        if (this.failDelete)
            throw new DomainError(503, "OBJECT_DELETE_PENDING", "Asset is inaccessible but physical deletion is pending");
        this.objects.delete(key);
    }
}
