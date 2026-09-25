import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "../../shared/errors.js";

export type SignedObjectRequest = {
  url: string;
  method: "PUT" | "GET";
  headers: Record<string, string>;
  expiresAt: Date;
};

export type ObjectInspection = {
  size: number;
  mime?: string;
  checksum?: string;
  prefix: Uint8Array;
};

export interface ObjectStorage {
  signedPut(input: { key: string; mime: string; size: number; checksum: string; ttlSeconds: number }): Promise<SignedObjectRequest>;
  signedGet(input: { key: string; filename: string; mime: string; ttlSeconds: number }): Promise<SignedObjectRequest>;
  inspect(key: string): Promise<ObjectInspection>;
  delete(key: string): Promise<void>;
}

const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1_000);
const hexToBase64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const base64ToHex = (base64: string) => Buffer.from(base64, "base64").toString("hex");

export class S3ObjectStorage implements ObjectStorage {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  async signedPut(input: { key: string; mime: string; size: number; checksum: string; ttlSeconds: number }) {
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
      method: "PUT" as const,
      headers: {
        "content-type": input.mime,
        "content-length": String(input.size),
        "x-amz-checksum-sha256": checksum,
      },
      expiresAt: expiresAt(input.ttlSeconds),
    };
  }

  async signedGet(input: { key: string; filename: string; mime: string; ttlSeconds: number }) {
    const safeFilename = input.filename.replace(/["\\\r\n]/g, "_");
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ResponseContentType: input.mime,
      ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
    });
    return {
      url: await getSignedUrl(this.client, command, { expiresIn: input.ttlSeconds }),
      method: "GET" as const,
      headers: {},
      expiresAt: expiresAt(input.ttlSeconds),
    };
  }

  async inspect(key: string): Promise<ObjectInspection> {
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

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

class UnavailableObjectStorage implements ObjectStorage {
  private unavailable(): never {
    throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Asset object storage is not configured");
  }
  signedPut(): Promise<SignedObjectRequest> { return Promise.reject(this.unavailable()); }
  signedGet(): Promise<SignedObjectRequest> { return Promise.reject(this.unavailable()); }
  inspect(): Promise<ObjectInspection> { return Promise.reject(this.unavailable()); }
  delete(): Promise<void> { return Promise.reject(this.unavailable()); }
}

export function objectStorageFromEnvironment(): ObjectStorage {
  const bucket = process.env.NORTH_ASSET_S3_BUCKET;
  const region = process.env.NORTH_ASSET_S3_REGION;
  if (!bucket || !region) return new UnavailableObjectStorage();
  return new S3ObjectStorage(new S3Client({
    region,
    ...(process.env.NORTH_ASSET_S3_ENDPOINT ? { endpoint: process.env.NORTH_ASSET_S3_ENDPOINT } : {}),
    forcePathStyle: process.env.NORTH_ASSET_S3_FORCE_PATH_STYLE === "true",
  }), bucket);
}

export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; mime: string; checksum: string }>();
  failDelete = false;
  put(key: string, value: { bytes: Uint8Array; mime: string; checksum: string }) { this.objects.set(key, value); }
  async signedPut(input: { key: string; mime: string; size: number; checksum: string; ttlSeconds: number }) {
    return { url: `https://storage.invalid/upload/${encodeURIComponent(input.key)}`, method: "PUT" as const, headers: { "content-type": input.mime, "content-length": String(input.size), "x-content-sha256": input.checksum }, expiresAt: expiresAt(input.ttlSeconds) };
  }
  async signedGet(input: { key: string; ttlSeconds: number }) {
    if (!this.objects.has(input.key)) throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object is unavailable");
    return { url: `https://storage.invalid/read/${encodeURIComponent(input.key)}`, method: "GET" as const, headers: {}, expiresAt: expiresAt(input.ttlSeconds) };
  }
  async inspect(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object is unavailable");
    return { size: object.bytes.byteLength, mime: object.mime, checksum: object.checksum, prefix: object.bytes.slice(0, 64) };
  }
  async delete(key: string) {
    if (this.failDelete) throw new DomainError(503, "OBJECT_DELETE_PENDING", "Asset is inaccessible but physical deletion is pending");
    this.objects.delete(key);
  }
}
