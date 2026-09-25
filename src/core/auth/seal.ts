import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * AES-256-GCM for secrets parked in Redis (the refresh grace cache holds a live token pair). The key
 * is derived from JWT_REFRESH_SECRET with HKDF, so a Redis dump alone reveals nothing usable.
 * `context` is bound as additional data: an entry only opens under the key it was written for.
 */
const key = Buffer.from(hkdfSync("sha256", env.JWT_REFRESH_SECRET, Buffer.alloc(0), "dsp:redis-seal:v1", 32));

export function seal(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** The plaintext, or null for anything tampered with, written under another context, or malformed. */
export function unseal(sealed: string, context: string): string | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
