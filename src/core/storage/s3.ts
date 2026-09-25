import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream } from "node:fs";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../../config/env.js";

// Static keys for MinIO; without them the SDK falls back to its default chain (instance role on EC2).
const credentials =
  env.S3_ACCESS_KEY && env.S3_SECRET_KEY ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } : undefined;

/** S3-compatible client for server-side operations (MinIO locally, any S3 bucket in production). */
export const s3 = new S3Client({ region: env.S3_REGION, endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE, credentials });

/**
 * Client used only to sign URLs handed to browsers and players. Signatures bind the host, so inside
 * Docker (where the API reaches MinIO as `minio:9000`) URLs must be signed for the public hostname.
 */
const s3Public = new S3Client({ region: env.S3_REGION, endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE, credentials });

const bucket = env.S3_BUCKET;

/** Short-lived URL the client uploads directly to (no bytes through the API). */
export function presignPut(key: string, contentType: string, expiresSec = 15 * 60): Promise<string> {
  return getSignedUrl(s3Public, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: expiresSec });
}

/** Short-lived download URL; media is never served through a guessable public path. */
export function presignGet(key: string, expiresSec = 60 * 60): Promise<string> {
  return getSignedUrl(s3Public, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresSec });
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

/**
 * Deletes every object under `prefix` (a company's `<companyId>/` folder), 1000 keys per request.
 * The prefix must be a non-empty folder so a bad argument can never empty the bucket.
 */
export async function deletePrefix(prefix: string): Promise<number> {
  if (!/^[A-Za-z0-9_-]+\/$/.test(prefix)) throw new Error(`Refusing to delete objects under prefix "${prefix}"`);
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/** Streams an object to a local file (worker-side processing). */
export async function downloadToFile(key: string, path: string): Promise<void> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Object ${key} has no body`);
  await pipeline(res.Body as Readable, createWriteStream(path));
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Object ${key} has no body`);
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}
