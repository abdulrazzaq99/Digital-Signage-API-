import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeContent } from "../core/assignments/content.js";
import { prisma } from "../core/db/prisma.js";
import { probeImage, probeVideo, rasterisePdf, thumbnail, UnsupportedMediaError, videoFrame, type Rendition } from "../core/media/process.js";
import { logger } from "../core/middleware/logger.js";
import { Events } from "../core/realtime/events.js";
import { emitToCompany } from "../core/realtime/server.js";
import { deleteObject, downloadToFile, putObject } from "../core/storage/s3.js";
import type { DerivativeKind, Prisma } from "../generated/prisma/client.js";

/** Generated files live next to the original, under `derived/`. */
export const derivedKey = (storageKey: string, name: string) => `${storageKey.slice(0, storageKey.lastIndexOf("/") + 1)}derived/${name}`;

interface Output {
  kind: DerivativeKind;
  page: number | null;
  key: string;
  file: Rendition;
}

/**
 * Post-upload processing (spec 6.1). Images: real dimensions and a thumbnail. Videos: ffprobe
 * against the player codec profile, real duration and size, and a thumbnail frame. PDFs: every
 * page rasterised to PNG for playback plus a first-page thumbnail. Files that can't be played
 * are marked FAILED with a reason the user can act on.
 */
export async function mediaConvert(data: { assetId: string; companyId: string }): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: data.assetId }, include: { derivatives: { select: { storageKey: true } } } });
  if (!asset || asset.status === "UPLOADING") return;
  const dir = await mkdtemp(join(tmpdir(), "dsp-media-"));
  try {
    const original = join(dir, "original");
    await downloadToFile(asset.storageKey, original);
    const outputs: Output[] = [];
    const thumb = async (input: string | Buffer) => outputs.push({ kind: "THUMBNAIL", page: null, key: derivedKey(asset.storageKey, "thumb.webp"), file: await thumbnail(input) });
    let meta: Prisma.MediaAssetUncheckedUpdateInput;

    if (asset.type === "IMAGE") {
      const { width, height } = await probeImage(original);
      meta = { width, height };
      await thumb(original);
    } else if (asset.type === "VIDEO") {
      const v = await probeVideo(original);
      meta = { width: v.width, height: v.height, durationSec: Math.max(1, Math.round(v.durationSec)) };
      await thumb(await videoFrame(original, Math.min(1, v.durationSec / 2)));
    } else {
      const pages = await rasterisePdf(original, dir);
      meta = { pages: pages.length, width: pages[0]!.width, height: pages[0]!.height };
      pages.forEach((file, i) => outputs.push({ kind: "PDF_PAGE", page: i + 1, key: derivedKey(asset.storageKey, `page-${i + 1}.png`), file }));
      await thumb(pages[0]!.body);
    }

    for (const o of outputs) await putObject(o.key, o.file.body, o.file.mimeType);
    // Swap the derivatives and mark the asset ready together; screens already playing it
    // (a re-processed PDF's pages, say) get a new manifest version.
    await changeContent(asset.companyId, { assetIds: [asset.id] }, async (tx) => {
      await tx.mediaDerivative.deleteMany({ where: { assetId: asset.id } });
      await tx.mediaDerivative.createMany({ data: outputs.map((o) => ({ assetId: asset.id, kind: o.kind, page: o.page, storageKey: o.key, width: o.file.width, height: o.file.height, mimeType: o.file.mimeType, sizeBytes: o.file.sizeBytes, checksum: o.file.checksum })) });
      await tx.mediaAsset.update({ where: { id: asset.id }, data: { ...meta, status: "READY", failureReason: null } });
    });
    const kept = new Set(outputs.map((o) => o.key));
    await Promise.all(asset.derivatives.filter((d) => !kept.has(d.storageKey)).map((d) => deleteObject(d.storageKey)));
    emitToCompany(data.companyId, Events.mediaReady, { assetId: asset.id, status: "READY" });
  } catch (err) {
    const rejected = err instanceof UnsupportedMediaError;
    if (!rejected) logger.error({ err, assetId: asset.id }, "media conversion failed");
    const failureReason = rejected ? err.message : "Processing failed. Retry, or upload the file again.";
    await changeContent(asset.companyId, { assetIds: [asset.id] }, (tx) => tx.mediaAsset.update({ where: { id: asset.id }, data: { status: "FAILED", failureReason } }));
    emitToCompany(data.companyId, Events.mediaReady, { assetId: asset.id, status: "FAILED" });
    // Unplayable files won't improve on retry; storage or tool outages might.
    if (!rejected) throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
