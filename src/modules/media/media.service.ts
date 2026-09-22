import { nanoid } from "nanoid";
import type { z } from "zod";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from "../../config/constants.js";
import { logActivity } from "../../core/audit/activity.js";
import { requireCompanyId, tenantWhere, type AuthUser, type TenantScope } from "../../core/auth/scope.js";
import { withTransaction } from "../../core/db/transaction.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import { enqueue, JobNames } from "../../core/queue/queues.js";
import { deleteObject, headObject, presignGet, presignPut } from "../../core/storage/s3.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { mediaRepository as repo, type MediaRow } from "./media.repository.js";
import type { finalizeBody, listMediaQuery, updateMediaBody, uploadUrlBody } from "./media.schemas.js";

/**
 * Presigned PUT lifetime: at least 15 minutes, or long enough to send the file at ~50 KB/s (a weak
 * mobile uplink), capped at 6 hours. Storage checks expiry when the PUT starts.
 */
export const uploadUrlTtlSec = (sizeBytes: number) => Math.min(6 * 60 * 60, Math.max(15 * 60, Math.ceil(sizeBytes / 50_000)));

export async function toMediaDto(m: MediaRow) {
  const thumb = m.derivatives[0]?.storageKey;
  return {
    id: m.id, name: m.name, type: m.type, status: m.status, mimeType: m.mimeType, sizeBytes: Number(m.sizeBytes), checksum: m.checksum, width: m.width, height: m.height, durationSec: m.durationSec, pages: m.pages, tags: m.tags, failureReason: m.failureReason, uploadedBy: m.uploadedBy?.name ?? null, createdAt: m.createdAt.toISOString(),
    usedIn: dedupe(m.playlistItems.map((i) => ({ id: i.playlist.id, name: i.playlist.name, kind: "PLAYLIST" as const }))),
    thumbnailUrl: thumb ? await presignGet(thumb) : m.type === "IMAGE" && m.status === "READY" ? await presignGet(m.storageKey) : null,
  };
}

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.\-() ]+/g, "_").slice(0, 200);
}

export const mediaService = {
  async list(scope: TenantScope, q: z.infer<typeof listMediaQuery>) {
    const where: Prisma.MediaAssetWhereInput = { ...tenantWhere(scope), ...(q.type ? { type: q.type } : {}), ...(q.status ? { status: q.status } : {}), ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}) };
    const { skip, take } = paginate(q);
    const [rows, total] = await repo.list(where, skip, take);
    const stats = scope.companyId ? await repo.stats(scope.companyId) : undefined;
    return { data: await Promise.all(rows.map(toMediaDto)), meta: { ...pageMeta(q, total), ...(stats ? { stats } : {}) } };
  },

  async get(scope: TenantScope, id: string) {
    const m = await repo.findScoped(scope.companyId, id);
    if (!m) throw new NotFoundError("Media");
    return toMediaDto(m);
  },

  /** Step 1 of upload: create the asset row in UPLOADING and return a presigned PUT URL. */
  async createUploadUrl(actor: AuthUser, scope: TenantScope, body: z.infer<typeof uploadUrlBody>) {
    const companyId = requireCompanyId(scope);
    const type = ALLOWED_MIME[body.contentType];
    const storageKey = `${companyId}/${nanoid(12)}/${sanitizeFileName(body.fileName)}`;
    const asset = await repo.create({ companyId, name: sanitizeFileName(body.fileName), type, status: "UPLOADING", mimeType: body.contentType, sizeBytes: BigInt(body.sizeBytes), storageKey, tags: body.tags, uploadedById: actor.id });
    const ttl = uploadUrlTtlSec(body.sizeBytes);
    const uploadUrl = await presignPut(storageKey, body.contentType, ttl);
    return { asset: await toMediaDto(asset), uploadUrl, expiresInSec: ttl };
  },

  /**
   * A fresh upload URL for an asset whose upload never completed (connection lost, URL expired,
   * finalize failed), so a retry reuses the asset instead of creating another one.
   */
  async reissueUploadUrl(scope: TenantScope, id: string) {
    const m = await repo.findScoped(scope.companyId, id);
    if (!m) throw new NotFoundError("Media");
    if (m.status !== "UPLOADING" && m.status !== "FAILED") throw new ConflictError("This file has already been uploaded", "NOT_UPLOADING");
    // Also moves updatedAt, which restarts the abandoned-upload clock.
    const updated = await repo.update(id, { status: "UPLOADING", failureReason: null });
    const ttl = uploadUrlTtlSec(Number(m.sizeBytes));
    return { asset: await toMediaDto(updated), uploadUrl: await presignPut(m.storageKey, m.mimeType, ttl), expiresInSec: ttl };
  },

  /**
   * Step 2 of upload: the client has PUT the bytes. Verify the object exists, its size and
   * content type match what was declared, then mark READY (images) or PROCESSING (video/PDF).
   */
  async finalize(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof finalizeBody>) {
    const m = await repo.findScoped(scope.companyId, id);
    if (!m) throw new NotFoundError("Media");
    if (m.status !== "UPLOADING" && m.status !== "FAILED") throw new ConflictError("Upload has already been finalized", "ALREADY_FINALIZED");
    const head = await headObject(m.storageKey);
    if (!head) throw new ValidationError("Uploaded file was not found in storage; upload the file before finalizing", undefined, "UPLOAD_MISSING");
    if (head.size > MAX_UPLOAD_BYTES) throw new ValidationError("File exceeds the 500 MB limit", { size: head.size }, "FILE_TOO_LARGE");
    if (head.contentType && head.contentType !== m.mimeType) throw new ValidationError(`Uploaded content type ${head.contentType} does not match declared ${m.mimeType}`, undefined, "UNSUPPORTED_MEDIA_TYPE");
    const needsProcessing = m.type !== "IMAGE";
    const updated = await repo.update(id, { status: needsProcessing ? "PROCESSING" : "READY", sizeBytes: BigInt(head.size), checksum: body.checksum ?? head.etag ?? null, width: body.width, height: body.height, durationSec: body.durationSec, pages: body.pages, failureReason: null });
    await enqueue(JobNames.mediaConvert, { assetId: id, companyId: m.companyId });
    await logActivity({ companyId: m.companyId, actor, action: "media.uploaded", resourceType: "media", resourceId: id, summary: `${m.name} uploaded (${(head.size / 1_048_576).toFixed(1)} MB)` });
    return toMediaDto(updated);
  },

  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateMediaBody>) {
    const m = await repo.findScoped(scope.companyId, id);
    if (!m) throw new NotFoundError("Media");
    const updated = await repo.update(id, { name: body.name ? sanitizeFileName(body.name) : undefined, tags: body.tags });
    if (body.name && body.name !== m.name) await logActivity({ companyId: m.companyId, actor, action: "media.renamed", resourceType: "media", resourceId: id, summary: `${m.name} renamed to ${body.name}` });
    return toMediaDto(updated);
  },

  async downloadUrl(scope: TenantScope, id: string) {
    const m = await repo.findScoped(scope.companyId, id);
    if (!m || m.status !== "READY") throw new NotFoundError("Media");
    return { url: await presignGet(m.storageKey), expiresInSec: 3600 };
  },

  async retry(actor: AuthUser, scope: TenantScope, id: string) {
    const m = await repo.findScoped(scope.companyId, id);
    if (!m) throw new NotFoundError("Media");
    if (m.status !== "FAILED") throw new ConflictError("Only failed uploads can be retried", "NOT_FAILED");
    const updated = await repo.update(id, { status: "PROCESSING", failureReason: null });
    await enqueue(JobNames.mediaConvert, { assetId: id, companyId: m.companyId });
    return toMediaDto(updated);
  },

  /** Deleting media that a playlist references requires `force`; forced deletes remove the items and log it. */
  async remove(actor: AuthUser, scope: TenantScope, id: string, force: boolean) {
    const m = await repo.findScoped(scope.companyId, id);
    if (!m) throw new NotFoundError("Media");
    const usedIn = dedupe(m.playlistItems.map((i) => i.playlist));
    if (usedIn.length && !force) throw new ConflictError(`This file is used in ${usedIn.length} playlist${usedIn.length > 1 ? "s" : ""}`, "MEDIA_IN_USE", { usedIn });
    await withTransaction(async (tx) => {
      if (usedIn.length) await repo.removeFromPlaylists(id, tx);
      await repo.delete(id, tx);
      await logActivity({ companyId: m.companyId, actor, action: "media.deleted", resourceType: "media", resourceId: id, summary: usedIn.length ? `${m.name} deleted and removed from ${usedIn.length} playlist(s)` : `${m.name} deleted`, meta: { usedIn } }, tx);
    });
    await deleteObject(m.storageKey);
    await Promise.all(m.derivatives.map((d) => deleteObject(d.storageKey)));
  },
};
