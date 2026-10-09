import test from "node:test";
import assert from "node:assert/strict";
import { createS3ObjectStorage } from "../src/infrastructure/object-storage.js";

test("presigned URLs use the public endpoint (path-style) while the private endpoint stays server-side", async () => {
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
  const checksum = "a".repeat(64);
  const withPublic = createS3ObjectStorage({ bucket: "corecrow-assets", region: "us-east-1", endpoint: "http://corecrow-minio:9000", publicEndpoint: "https://api.example.test", forcePathStyle: true });
  const put = new URL((await withPublic.signedPut({ key: "north-assets/o/1", mime: "image/png", size: 10, checksum, ttlSeconds: 300 })).url);
  assert.equal(put.origin, "https://api.example.test");
  assert.equal(put.pathname, "/corecrow-assets/north-assets/o/1");
  assert.ok(put.searchParams.get("X-Amz-Signature"), "unsigned object access is never produced");
  assert.ok(put.searchParams.get("X-Amz-SignedHeaders")?.includes("host"));
  const get = new URL((await withPublic.signedGet({ key: "north-assets/o/1", versionId: "v-1", filename: "f.png", mime: "image/png", ttlSeconds: 300 })).url);
  assert.equal(get.origin, "https://api.example.test");
  assert.equal(get.searchParams.get("versionId"), "v-1");

  const withoutPublic = createS3ObjectStorage({ bucket: "corecrow-assets", region: "us-east-1", endpoint: "http://corecrow-minio:9000", forcePathStyle: true });
  assert.equal(new URL((await withoutPublic.signedPut({ key: "k", mime: "image/png", size: 10, checksum, ttlSeconds: 300 })).url).origin, "http://corecrow-minio:9000");
});
