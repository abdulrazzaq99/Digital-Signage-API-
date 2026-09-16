import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";

/** S3-compatible client (MinIO locally, any S3 bucket in production). */
export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
});

const bucket = env.S3_BUCKET;

/** Short-lived URL the client uploads directly to (no bytes through the API). */
export function presignPut(key: string, contentType: string, expiresSec = 15 * 60): Promise<string> {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: expiresSec });
}

/** Short-lived download URL; media is never served through a guessable public path. */
export function presignGet(key: string, expiresSec = 60 * 60): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresSec });
}

export async function headObject(key: string): Promise<{ size: number; contentType?: string; etag?: string } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType, etag: res.ETag?.replace(/"/g, "") };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
}

export function publicUrl(key: string): string {
  return `${env.S3_PUBLIC_URL}/${key}`;
}
