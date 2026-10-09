import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { datasetImportMalwareScannerFromEnvironment } from "../dist/modules/north/data/import-malware-scanner.js";
import { datasetImportStorageFromEnvironment } from "../dist/modules/north/data/import-storage.js";

const payload = Buffer.from("CoreCrow dataset infrastructure probe\n", "utf8");
const checksum = createHash("sha256").update(payload).digest("hex");
const storage = datasetImportStorageFromEnvironment();
const bucket = process.env.NORTH_DATA_IMPORT_S3_BUCKET?.trim();
const region = process.env.NORTH_DATA_IMPORT_S3_REGION?.trim();
if (!bucket || !region) throw new Error("Dataset infrastructure probe requires S3 bucket and region configuration");

const client = new S3Client({
  region,
  endpoint: process.env.NORTH_DATA_IMPORT_S3_ENDPOINT?.trim() || undefined,
  forcePathStyle: process.env.NORTH_DATA_IMPORT_S3_FORCE_PATH_STYLE === "true",
});
const key = `corecrow-infrastructure-probe/${randomUUID()}`;
let versionId;

async function readBody(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

await storage.assertImmutableVersioning();

try {
  const uploaded = await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: payload,
    ContentType: "text/plain",
    ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
    Metadata: { "corecrow-probe-checksum": checksum },
  }));
  versionId = uploaded.VersionId;
  if (!versionId || versionId === "null") {
    const current = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    versionId = current.VersionId;
  }
  if (!versionId || versionId === "null")
    throw new Error("Dataset infrastructure probe did not receive an immutable object version ID");

  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  if (head.VersionId !== versionId || head.ContentLength !== payload.byteLength || head.Metadata?.["corecrow-probe-checksum"] !== checksum)
    throw new Error("Dataset infrastructure probe HEAD response did not match the pinned object version");

  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  if (!object.Body) throw new Error("Dataset infrastructure probe could not read the pinned object version");
  const downloaded = await readBody(object.Body);
  if (createHash("sha256").update(downloaded).digest("hex") !== checksum)
    throw new Error("Dataset infrastructure probe read bytes with an unexpected checksum");

  const verdict = await datasetImportMalwareScannerFromEnvironment({ maximumBytes: payload.byteLength }).scan({
    filename: "corecrow-infrastructure-probe.txt",
    mime: "text/plain",
    size: payload.byteLength,
    checksum,
    openPrivateRead: async () => Readable.from([payload]),
    signal: AbortSignal.timeout(35_000),
  });
  if (verdict !== "APPROVED") throw new Error(`ClamAV probe was not approved: ${verdict}`);
} finally {
  // Delete the exact version so a versioned bucket does not retain this probe.
  if (versionId) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
}

console.info("Dataset infrastructure probe passed: versioned S3 access and ClamAV are available.");
