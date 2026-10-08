import { fail } from "../../shared/errors.js";
import { AVATAR_MIMES } from "../identity/avatar-policy.js";

export const ICON_ASSET_MAX_BYTES = 1024 * 1024;

/** An organization icon must be a live, READY, small raster image. Tenant match is enforced by the caller's query and the composite FK. */
export function assertIconAsset(asset: { mime: string; size: bigint | number; status: string; deletedAt: Date | null } | null) {
  if (!asset || asset.deletedAt || asset.status !== "READY") fail(422, "ICON_ASSET_INVALID", "Icon asset is not available");
  if (!(AVATAR_MIMES as readonly string[]).includes(asset.mime)) fail(422, "ICON_ASSET_INVALID", "Icon must be a JPEG, PNG or WebP image");
  if (Number(asset.size) > ICON_ASSET_MAX_BYTES) fail(422, "ICON_ASSET_INVALID", "Icon must be at most 1 MiB");
}
