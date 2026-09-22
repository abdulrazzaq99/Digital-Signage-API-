import { ABANDONED_UPLOAD_SEC } from "../config/constants.js";
import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";
import { deleteObject } from "../core/storage/s3.js";

/** Deletes uploads left UPLOADING for 24 hours, with any partial object. Runs on the worker hourly. */
export async function mediaCleanup(): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_SEC * 1000);
  const stale = await prisma.mediaAsset.findMany({ where: { status: "UPLOADING", updatedAt: { lt: cutoff } }, select: { id: true, storageKey: true } });
  let removed = 0;
  for (const m of stale) {
    // Re-checked in the delete, so an upload URL re-issued in the meantime keeps the asset.
    const { count } = await prisma.mediaAsset.deleteMany({ where: { id: m.id, status: "UPLOADING", updatedAt: { lt: cutoff } } });
    if (!count) continue;
    await deleteObject(m.storageKey);
    removed++;
  }
  if (removed) logger.info({ removed }, "abandoned uploads removed");
  return { removed };
}
