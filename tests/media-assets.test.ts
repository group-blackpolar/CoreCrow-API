import test from "node:test";
import assert from "node:assert/strict";
import { assetConfiguration } from "../src/modules/north/asset-config.js";
import { AVATAR_MAX_BYTES, validateAvatarDeclaration } from "../src/modules/identity/avatar-policy.js";
import { assertIconAsset, ICON_ASSET_MAX_BYTES } from "../src/modules/tenancy/icon-asset.js";

const config = assetConfiguration();
const checksum = "a".repeat(64);
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as { code?: string }).code; } return undefined; };

test("avatar declaration: JPEG/PNG/WebP up to 2 MiB only", () => {
  for (const mime of ["image/jpeg", "image/png", "image/webp"]) assert.equal(validateAvatarDeclaration({ mime, size: 1000, checksum }, config).mime, mime);
  assert.equal(code(() => validateAvatarDeclaration({ mime: "image/gif", size: 1000, checksum }, config)), "ASSET_MIME_NOT_ALLOWED");
  assert.equal(code(() => validateAvatarDeclaration({ mime: "application/pdf", size: 1000, checksum }, config)), "ASSET_MIME_NOT_ALLOWED");
  assert.equal(code(() => validateAvatarDeclaration({ mime: "image/png", size: AVATAR_MAX_BYTES + 1, checksum }, config)), "ASSET_SIZE_INVALID");
  assert.equal(code(() => validateAvatarDeclaration({ mime: "image/png", size: AVATAR_MAX_BYTES, checksum }, config)), undefined);
  assert.equal(code(() => validateAvatarDeclaration({ mime: "image/png", size: 0, checksum }, config)), "ASSET_SIZE_INVALID");
  assert.equal(code(() => validateAvatarDeclaration({ mime: "image/png", size: 10, checksum: "xyz" }, config)), "ASSET_CHECKSUM_INVALID");
});

test("avatar cap never exceeds a lower configured image cap", () => {
  const small = { ...config, maximumBytes: { ...config.maximumBytes, image: 500 } };
  assert.equal(code(() => validateAvatarDeclaration({ mime: "image/png", size: 501, checksum }, small)), "ASSET_SIZE_INVALID");
});

test("icon asset: must be a live READY small raster image", () => {
  const ok = { mime: "image/png", size: 1000n, status: "READY", deletedAt: null };
  assert.equal(code(() => assertIconAsset(ok)), undefined);
  assert.equal(code(() => assertIconAsset(null)), "ICON_ASSET_INVALID");
  assert.equal(code(() => assertIconAsset({ ...ok, status: "UPLOADING" })), "ICON_ASSET_INVALID");
  assert.equal(code(() => assertIconAsset({ ...ok, deletedAt: new Date() })), "ICON_ASSET_INVALID");
  assert.equal(code(() => assertIconAsset({ ...ok, mime: "image/gif" })), "ICON_ASSET_INVALID");
  assert.equal(code(() => assertIconAsset({ ...ok, mime: "application/pdf" })), "ICON_ASSET_INVALID");
  assert.equal(code(() => assertIconAsset({ ...ok, size: BigInt(ICON_ASSET_MAX_BYTES + 1) })), "ICON_ASSET_INVALID");
});
