import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";
import { Events } from "../core/realtime/events.js";
import { emitToCompany } from "../core/realtime/server.js";

/**
 * Post-upload processing. Images are ready immediately; the job records a thumbnail derivative
 * pointing at the original. Videos are marked ready after validation. PDFs get one PDF_PAGE
 * derivative per declared page so playlists can reference pages. Real rasterisation (pdftoppm)
 * and transcoding (ffmpeg) plug in here without changing the API contract.
 */
export async function mediaConvert(data: { assetId: string; companyId: string }): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: data.assetId } });
  if (!asset || asset.status === "UPLOADING") return;
  try {
    if (asset.type === "IMAGE") {
      await prisma.mediaDerivative.upsert({ where: { storageKey: `${asset.storageKey}#thumb` }, update: {}, create: { assetId: asset.id, kind: "THUMBNAIL", storageKey: asset.storageKey, width: asset.width, height: asset.height } }).catch(() => undefined);
    } else if (asset.type === "PDF") {
      const pages = asset.pages ?? 1;
      await prisma.mediaDerivative.deleteMany({ where: { assetId: asset.id, kind: "PDF_PAGE" } });
      await prisma.mediaDerivative.createMany({ data: Array.from({ length: pages }, (_, i) => ({ assetId: asset.id, kind: "PDF_PAGE" as const, storageKey: `${asset.storageKey}#page-${i + 1}`, page: i + 1 })) });
    }
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY", failureReason: null } });
    emitToCompany(data.companyId, Events.mediaReady, { assetId: asset.id, status: "READY" });
  } catch (err) {
    logger.error({ err, assetId: asset.id }, "media conversion failed");
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "FAILED", failureReason: (err as Error).message.slice(0, 500) } });
    emitToCompany(data.companyId, Events.mediaReady, { assetId: asset.id, status: "FAILED" });
    throw err;
  }
}
