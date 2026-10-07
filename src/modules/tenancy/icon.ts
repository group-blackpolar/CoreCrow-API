import { fail } from "../../shared/errors.js";
import { isDecodableImage, sniffImage } from "../documents/images.js";
import sharp from "sharp";

export const ICON_MAX_BYTES = 256 * 1024;
export const ICON_MAX_SIDE = 512;

/** Validates an organization icon data URL: signature-sniffed PNG/JPEG/WebP, decodable, <=512x512, <=256 KB. */
export async function validateOrganizationIcon(dataUrl: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) fail(400, "ICON_INVALID", "Icon must be a PNG, JPEG or WebP data URL");
  const data = Buffer.from(match[2]!, "base64");
  if (data.length === 0 || data.length > ICON_MAX_BYTES)
    fail(413, "ICON_TOO_LARGE", "Icon must be at most 256 KB");
  const mime = sniffImage(data);
  if (!mime || mime !== match[1] || !(await isDecodableImage(data, mime)))
    fail(400, "ICON_INVALID", "Icon is not a valid image");
  const meta = await sharp(data).metadata();
  if ((meta.width ?? 0) > ICON_MAX_SIDE || (meta.height ?? 0) > ICON_MAX_SIDE)
    fail(400, "ICON_DIMENSIONS", "Icon must be at most 512x512 pixels");
  return `data:${mime};base64,${data.toString("base64")}`;
}
