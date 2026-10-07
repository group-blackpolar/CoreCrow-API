import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Reversible protection for AUIDs (Reveal only; login verifies the irreversible hash).
 * Format `v<version>:<iv>:<ciphertext>:<tag>` (base64url). The key is server-side only, 256 bits, taken from
 * AUID_ENCRYPTION_KEY (version 1) or AUID_ENCRYPTION_KEY_V<n>; hex (64 chars) or base64. The ciphertext is bound
 * to its owner through AAD so it cannot be moved between users. To rotate: add AUID_ENCRYPTION_KEY_V2, bump
 * CURRENT_VERSION; older versions keep decrypting until their admins regenerate.
 */
export const CURRENT_VERSION = 1;

/** `key_unavailable`: configuration. `malformed` / `authentication_failed`: possible corruption or tampering. */
export class AuidCryptoError extends Error {
  constructor(readonly kind: "key_unavailable" | "malformed" | "authentication_failed") {
    super(`AUID crypto: ${kind}`);
  }
}

function keyFor(version: number) {
  const raw = process.env[version === 1 ? "AUID_ENCRYPTION_KEY" : `AUID_ENCRYPTION_KEY_V${version}`];
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("AUID encryption key must be exactly 32 bytes");
  return key;
}

export const auidEncryptionAvailable = () => keyFor(CURRENT_VERSION) !== null;

const aad = (userId: string) => Buffer.from(`auid:${userId}`);

export function encryptAuid(userId: string, plaintext: string) {
  const key = keyFor(CURRENT_VERSION);
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(userId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const parts = [iv, body, cipher.getAuthTag()].map((part) => part.toString("base64url"));
  return { ciphertext: `v${CURRENT_VERSION}:${parts.join(":")}`, version: CURRENT_VERSION };
}

export function decryptAuid(userId: string, ciphertext: string, version: number) {
  const key = keyFor(version);
  if (!key) throw new AuidCryptoError("key_unavailable");
  const [tag, iv, body, auth] = ciphertext.split(":");
  if (tag !== `v${version}` || !iv || !body || !auth) throw new AuidCryptoError("malformed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(Buffer.from(auth, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AuidCryptoError("authentication_failed");
  }
}
