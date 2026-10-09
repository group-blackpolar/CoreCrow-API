// Operational probe for the asset/avatar pipeline, independent of dataset imports. Run inside the release image
// (it loads the compiled modules from dist/) after `pnpm build`:
//   node scripts/verify-asset-infrastructure.mjs
// It never prints credentials, object keys or file contents. It checks, against the real services:
//   private bucket access with the application identity, versioning (exact VersionId), PUT/HEAD/GET checksum,
//   pinned-version reads, signed-URL read of the pinned version, ClamAV INSTREAM on a clean object (APPROVED) and on the
//   standard EICAR test string (QUARANTINED), and that every probe object version is removed afterwards.
import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { malwareScannerFromEnvironment } from "../dist/modules/north/malware-scanner.js";
import { objectStorageFromEnvironment } from "../dist/modules/north/object-storage.js";

const bucket = process.env.NORTH_ASSET_S3_BUCKET?.trim();
const region = process.env.NORTH_ASSET_S3_REGION?.trim();
if (!bucket || !region) throw new Error("Asset infrastructure probe requires NORTH_ASSET_S3_BUCKET and NORTH_ASSET_S3_REGION");

const client = new S3Client({
  region,
  endpoint: process.env.NORTH_ASSET_S3_ENDPOINT?.trim() || undefined,
  forcePathStyle: process.env.NORTH_ASSET_S3_FORCE_PATH_STYLE === "true",
});
const storage = objectStorageFromEnvironment();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const prefix = `corecrow-asset-probe/${randomUUID()}/`;
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(`ok   ${name}`); }
  catch (error) { results.push(`FAIL ${name}: ${error?.code ?? error?.name ?? "error"}`); throw error; }
};

async function put(name, body, contentType) {
  const checksum = sha256(body);
  const sent = await client.send(new PutObjectCommand({
    Bucket: bucket, Key: prefix + name, Body: body, ContentType: contentType,
    ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
  }));
  return { key: prefix + name, checksum, putVersionId: sent.VersionId };
}

// The standard anti-malware test string; harmless, and detected by every engine.
const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "ascii");

try {
  const clean = Buffer.from("CoreCrow asset infrastructure probe\n", "utf8");
  let cleanObject;
  await step("versioned private PUT with SHA-256 and exact VersionId", async () => {
    cleanObject = await put("clean.txt", clean, "text/plain");
    if (!cleanObject.putVersionId || cleanObject.putVersionId === "null") throw new Error("bucket versioning is not enabled");
  });
  await step("HEAD/GET inspection matches size, checksum and version", async () => {
    const inspected = await storage.inspect(cleanObject.key);
    if (inspected.size !== clean.byteLength || inspected.checksum !== cleanObject.checksum) throw new Error("inspection mismatch");
    if (inspected.versionId !== cleanObject.putVersionId) throw new Error("inspection did not report the exact version");
    const pinned = await storage.inspect(cleanObject.key, cleanObject.putVersionId);
    if (pinned.versionId !== cleanObject.putVersionId) throw new Error("pinned inspection mismatch");
  });
  await step("signed GET is pinned to the exact version", async () => {
    const signed = await storage.signedGet({ key: cleanObject.key, versionId: cleanObject.putVersionId, filename: "probe.txt", mime: "text/plain", ttlSeconds: 60 });
    if (!new URL(signed.url).searchParams.has("versionId")) throw new Error("signed URL is not version-pinned");
  });
  await step("ClamAV INSTREAM approves the clean object (pinned version)", async () => {
    const verdict = await malwareScannerFromEnvironment(storage, { maximumBytes: clean.byteLength }).scan({
      storageKey: cleanObject.key, storageVersionId: cleanObject.putVersionId, mime: "text/plain", size: clean.byteLength, checksum: cleanObject.checksum,
    });
    if (verdict !== "APPROVED") throw new Error(`clean object was ${verdict}`);
  });
  await step("ClamAV INSTREAM quarantines the EICAR test object", async () => {
    const infected = await put("eicar.com", eicar, "application/octet-stream");
    const verdict = await malwareScannerFromEnvironment(storage, { maximumBytes: eicar.byteLength }).scan({
      storageKey: infected.key, storageVersionId: infected.putVersionId, mime: "application/octet-stream", size: eicar.byteLength, checksum: infected.checksum,
    });
    if (verdict !== "QUARANTINED") throw new Error(`EICAR was ${verdict}`);
  });
  console.info(results.join("\n"));
  console.info("Asset infrastructure probe passed: private versioned storage and ClamAV are working.");
} catch (error) {
  console.error(results.join("\n"));
  console.error("Asset infrastructure probe FAILED.");
  process.exitCode = 1;
} finally {
  // A versioned bucket keeps every version: remove each version and delete marker of this probe, not just the key.
  try {
    const listing = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
    for (const item of [...(listing.Versions ?? []), ...(listing.DeleteMarkers ?? [])])
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key, VersionId: item.VersionId }));
  } catch {
    console.error("Probe cleanup could not remove every probe object version; remove the corecrow-asset-probe/ prefix manually.");
    process.exitCode = 1;
  }
}
