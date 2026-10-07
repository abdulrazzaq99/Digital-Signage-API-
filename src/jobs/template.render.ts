import { changeContent } from "../core/assignments/content.js";
import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";
import { Events } from "../core/realtime/events.js";
import { emitToCompany } from "../core/realtime/server.js";
import { deleteObject, getObjectBuffer, putObject } from "../core/storage/s3.js";
import { renderTemplate } from "../modules/templates/templates.render.js";
import { templateField } from "../modules/templates/templates.schemas.js";
import { effectiveValues } from "../modules/templates/templates.service.js";

/**
 * Renders a template instance to a PNG at the target resolution and swaps it in. The previous
 * output stays live until then; the swap and the manifest bump of every screen showing it
 * happen together. Jobs for values that were already rendered are skipped.
 */
export async function templateRender(data: { instanceId: string; companyId: string }): Promise<void> {
  const instance = await prisma.templateInstance.findUnique({ where: { id: data.instanceId }, include: { template: true } });
  if (!instance || (!instance.renderPending && instance.outputKey)) return;
  const fields = (instance.template.fields as unknown[]).map((f) => templateField.parse(f));
  const own = instance.values as Record<string, string>;
  const values = effectiveValues(fields, own);
  try {
    // An image is the location's media asset ID, or Head Office's own image when the field is
    // locked or the location left it blank. One that is gone or unreadable is left out rather
    // than failing the whole render.
    const fromLibrary = (f: (typeof fields)[number]) => !f.locked && !!own[f.key]?.trim();
    const imageIds = fields.filter((f) => f.type === "image" && fromLibrary(f)).map((f) => own[f.key]!);
    const assets = await prisma.mediaAsset.findMany({ where: { id: { in: imageIds }, companyId: instance.companyId, type: "IMAGE", status: "READY" }, select: { id: true, storageKey: true } });
    const images = new Map<string, Buffer>();
    for (const f of fields.filter((x) => x.type === "image")) {
      const key = fromLibrary(f) ? assets.find((x) => x.id === own[f.key])?.storageKey : f.default;
      if (!key) continue;
      try {
        images.set(f.key, await getObjectBuffer(key));
      } catch (err) {
        logger.warn({ err, instanceId: instance.id, key }, "template image unavailable; rendering without it");
      }
    }
    const out = await renderTemplate({ orientation: instance.template.orientation, fields, values, images });
    const key = `${data.companyId}/templates/${instance.id}/${Date.now()}.png`;
    await putObject(key, out.body, out.mimeType);
    await changeContent(data.companyId, { templateInstanceIds: [instance.id] }, async (tx) => {
      // Values edited during the render keep it pending; their own job renders them next.
      const current = await tx.templateInstance.findUnique({ where: { id: instance.id }, select: { valuesVersion: true } });
      await tx.templateInstance.update({ where: { id: instance.id }, data: { outputKey: key, outputMimeType: out.mimeType, outputChecksum: out.checksum, outputSizeBytes: out.sizeBytes, outputWidth: out.width, outputHeight: out.height, renderPending: current?.valuesVersion !== instance.valuesVersion } });
    });
    if (instance.outputKey) await deleteObject(instance.outputKey);
    emitToCompany(data.companyId, Events.mediaReady, { templateInstanceId: instance.id, status: "READY" });
  } catch (err) {
    logger.error({ err, instanceId: instance.id }, "template render failed");
    throw err;
  }
}
