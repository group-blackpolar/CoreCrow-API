import { fail } from "../../shared/errors.js";
import type { AssetConfiguration } from "../north/asset-config.js";
import { validateAssetDeclaration } from "../north/asset-policy.js";

export const AVATAR_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const extension: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Avatars are a strict subset of the asset rules: JPEG/PNG/WebP only, at most 2 MiB (or the configured image cap if lower). */
export function validateAvatarDeclaration(input: { mime: string; size: number; checksum: string }, config: AssetConfiguration) {
  if (!(AVATAR_MIMES as readonly string[]).includes(input.mime)) fail(422, "ASSET_MIME_NOT_ALLOWED", "Avatar must be a JPEG, PNG or WebP image");
  return validateAssetDeclaration(
    { ...input, filename: `avatar.${extension[input.mime]}` },
    { ...config, maximumBytes: { ...config.maximumBytes, image: Math.min(config.maximumBytes.image, AVATAR_MAX_BYTES) } },
  );
}
