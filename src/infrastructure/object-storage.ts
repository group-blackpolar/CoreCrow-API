import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "../shared/errors.js";

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
  versionId?: string;
  etag?: string;
};

export interface ObjectStorage {
  signedPut(input: { key: string; mime: string; size: number; checksum: string; ttlSeconds: number }): Promise<SignedObjectRequest>;
  signedGet(input: { key: string; filename: string; mime: string; ttlSeconds: number; versionId?: string }): Promise<SignedObjectRequest>;
  inspect(key: string, versionId?: string): Promise<ObjectInspection>;
  openPrivateRead(key: string, versionId?: string): Promise<Readable>;
  assertImmutableVersioning(): Promise<void>;
  delete(key: string): Promise<void>;
}

export type S3ObjectStorageConfiguration = {
  bucket: string;
  region: string;
  endpoint?: string;
  /**
   * Host browsers use for presigned URLs (for example `https://api.blackpolar.org`, proxied by nginx to the private store).
   * Presigning is a local computation, so it needs no network path from the API to this address; every server-side call
   * (inspect, scan, delete) keeps using the private `endpoint`.
   */
  publicEndpoint?: string;
  forcePathStyle?: boolean;
  /**
   * `delete` permanently removes every version and delete marker of the key (needs s3:ListBucketVersions and
   * s3:DeleteObjectVersion on it). Off by default: dataset imports keep immutable history and only add a delete marker.
   */
  purgeVersions?: boolean;
};

const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1_000);
const hexToBase64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const base64ToHex = (base64: string) => Buffer.from(base64, "base64").toString("hex");

export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly purgeVersions = false,
    private readonly signer: S3Client = client,
  ) {}

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
      url: await getSignedUrl(this.signer, command, { expiresIn: input.ttlSeconds }),
      method: "PUT" as const,
      headers: {
        "content-type": input.mime,
        "content-length": String(input.size),
        "x-amz-checksum-sha256": checksum,
      },
      expiresAt: expiresAt(input.ttlSeconds),
    };
  }

  async signedGet(input: { key: string; filename: string; mime: string; ttlSeconds: number; versionId?: string }) {
    const safeFilename = input.filename.replace(/["\\\r\n]/g, "_");
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ...(input.versionId ? { VersionId: input.versionId } : {}),
      ResponseContentType: input.mime,
      ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
    });
    return {
      url: await getSignedUrl(this.signer, command, { expiresIn: input.ttlSeconds }),
      method: "GET" as const,
      headers: {},
      expiresAt: expiresAt(input.ttlSeconds),
    };
  }

  async inspect(key: string, versionId?: string): Promise<ObjectInspection> {
    try {
      const head = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ChecksumMode: "ENABLED",
        ...(versionId ? { VersionId: versionId } : {}),
      }));
      const pinnedVersionId = versionId ?? head.VersionId;
      const prefix = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: "bytes=0-63",
        ...(pinnedVersionId ? { VersionId: pinnedVersionId } : {}),
      }));
      if (head.ContentLength === undefined || !Number.isSafeInteger(head.ContentLength) || !prefix.Body)
        throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object metadata could not be verified");
      return {
        size: head.ContentLength,
        mime: head.ContentType,
        checksum: head.ChecksumSHA256 ? base64ToHex(head.ChecksumSHA256) : undefined,
        prefix: await prefix.Body.transformToByteArray(),
        versionId: head.VersionId,
        etag: head.ETag,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object metadata could not be verified");
    }
  }

  async openPrivateRead(key: string, versionId?: string) {
    try {
      const object = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(versionId ? { VersionId: versionId } : {}),
      }));
      if (!object.Body || !(object.Body instanceof Readable))
        throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object stream is unavailable");
      return object.Body;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object stream is unavailable");
    }
  }

  async assertImmutableVersioning() {
    try {
      const versioning = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket }));
      if (versioning.Status === "Enabled") return;
    } catch {
      // Normalize provider/authentication failures to the same fail-closed gate.
    }
    throw new DomainError(
      503,
      "IMPORT_STORAGE_IMMUTABILITY_UNAVAILABLE",
      "Dataset import storage must have object versioning enabled",
    );
  }

  async delete(key: string) {
    if (!this.purgeVersions) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return;
    }
    // Versioned bucket: a plain delete only adds a marker and keeps the bytes. Remove every version of exactly this key.
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
      for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])])
        if (item.Key === key)
          await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, ...(item.VersionId ? { VersionId: item.VersionId } : {}) }));
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
  }
}

export class UnavailableObjectStorage implements ObjectStorage {
  private unavailable(): never {
    throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object storage is not configured");
  }
  signedPut(): Promise<SignedObjectRequest> { return Promise.reject(this.unavailable()); }
  signedGet(): Promise<SignedObjectRequest> { return Promise.reject(this.unavailable()); }
  inspect(): Promise<ObjectInspection> { return Promise.reject(this.unavailable()); }
  openPrivateRead(): Promise<Readable> { return Promise.reject(this.unavailable()); }
  assertImmutableVersioning(): Promise<void> { return Promise.reject(this.unavailable()); }
  delete(): Promise<void> { return Promise.reject(this.unavailable()); }
}

export function createS3ObjectStorage(configuration: S3ObjectStorageConfiguration): ObjectStorage {
  const client = (endpoint?: string) => new S3Client({
    region: configuration.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: configuration.forcePathStyle === true,
  });
  const internal = client(configuration.endpoint);
  const signer = configuration.publicEndpoint ? client(configuration.publicEndpoint) : internal;
  return new S3ObjectStorage(internal, configuration.bucket, configuration.purgeVersions === true, signer);
}

export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; mime: string; checksum: string }>();
  private readonly versions = new Map<string, { bytes: Uint8Array; mime: string; checksum: string }>();
  private nextVersion = 1;
  failDelete = false;
  constructor(public versioningEnabled = true) {}
  put(key: string, value: { bytes: Uint8Array; mime: string; checksum: string }) {
    this.objects.set(key, value);
    if (!this.versioningEnabled) return;
    const versionId = `fake-version-${this.nextVersion++}`;
    this.versions.set(`${key}\0${versionId}`, value);
    return versionId;
  }
  async signedPut(input: { key: string; mime: string; size: number; checksum: string; ttlSeconds: number }) {
    return { url: `https://storage.invalid/upload/${encodeURIComponent(input.key)}`, method: "PUT" as const, headers: { "content-type": input.mime, "content-length": String(input.size), "x-content-sha256": input.checksum }, expiresAt: expiresAt(input.ttlSeconds) };
  }
  async signedGet(input: { key: string; ttlSeconds: number; versionId?: string }) {
    if (input.versionId ? !this.versions.has(`${input.key}\0${input.versionId}`) : !this.objects.has(input.key)) throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object is unavailable");
    return { url: `https://storage.invalid/read/${encodeURIComponent(input.key)}${input.versionId ? `?versionId=${encodeURIComponent(input.versionId)}` : ""}`, method: "GET" as const, headers: {}, expiresAt: expiresAt(input.ttlSeconds) };
  }
  async inspect(key: string, versionId?: string) {
    const object = versionId ? this.versions.get(`${key}\0${versionId}`) : this.objects.get(key);
    if (!object) throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object is unavailable");
    const latestVersionId = versionId ?? (this.versioningEnabled
      ? [...this.versions.keys()].reverse().find((candidate) => candidate.startsWith(`${key}\0`))?.slice(key.length + 1)
      : undefined);
    return {
      size: object.bytes.byteLength,
      mime: object.mime,
      checksum: object.checksum,
      prefix: object.bytes.slice(0, 64),
      versionId: latestVersionId,
      etag: object.checksum,
    };
  }
  async openPrivateRead(key: string, versionId?: string) {
    const object = versionId ? this.versions.get(`${key}\0${versionId}`) : this.objects.get(key);
    if (!object) throw new DomainError(503, "OBJECT_STORAGE_UNAVAILABLE", "Object is unavailable");
    return Readable.from([object.bytes]);
  }
  async assertImmutableVersioning() {
    if (!this.versioningEnabled)
      throw new DomainError(
        503,
        "IMPORT_STORAGE_IMMUTABILITY_UNAVAILABLE",
        "Dataset import storage must have object versioning enabled",
      );
  }
  async delete(key: string) {
    if (this.failDelete) throw new DomainError(503, "OBJECT_DELETE_PENDING", "Object is inaccessible but physical deletion is pending");
    this.objects.delete(key);
    for (const entry of [...this.versions.keys()]) if (entry.startsWith(`${key}\0`)) this.versions.delete(entry);
  }
}
