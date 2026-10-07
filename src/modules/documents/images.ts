import sharp from "sharp";

/**
 * Attachment images. The file signature decides the type (the declared content type is never trusted) and
 * the file must actually decode. PDFKit embeds only JPEG and PNG, so WebP is converted to PNG for the PDF
 * while the original is stored and served unchanged.
 */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

// Guards against decompression bombs: a 5 MiB file may still declare an enormous canvas.
const MAX_PIXELS = 40_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImage(data: Buffer): ImageMime | null {
  if (data.length > 12 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 12 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (data.length > 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** True when the bytes parse as an image of the sniffed format within the pixel limit. */
export async function isDecodableImage(data: Buffer, mime: ImageMime): Promise<boolean> {
  try {
    const meta = await sharp(data, { limitInputPixels: MAX_PIXELS }).metadata();
    const expected = mime === "image/jpeg" ? "jpeg" : mime === "image/png" ? "png" : "webp";
    return meta.format === expected && Boolean(meta.width) && Boolean(meta.height);
  } catch {
    return false;
  }
}

/** Bytes PDFKit can embed: JPEG and PNG as stored, WebP converted (alpha preserved). */
export async function pdfReadyImage(image: { mime: string; data: Buffer }): Promise<Buffer> {
  if (image.mime !== "image/webp") return image.data;
  return sharp(image.data, { limitInputPixels: MAX_PIXELS }).png().toBuffer();
}
