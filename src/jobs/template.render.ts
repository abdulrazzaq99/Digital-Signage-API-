import { PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";
import { Events } from "../core/realtime/events.js";
import { emitToCompany } from "../core/realtime/server.js";
import { s3 } from "../core/storage/s3.js";

/**
 * Renders a template instance to a player-cacheable asset. This implementation writes an SVG
 * built from the template fields, which every Android WebView player can display. Swapping in
 * a headless-browser PNG renderer changes only this file.
 */
export async function templateRender(data: { instanceId: string; companyId: string }): Promise<void> {
  const instance = await prisma.templateInstance.findUnique({ where: { id: data.instanceId }, include: { template: true } });
  if (!instance) return;
  const values = instance.values as Record<string, string>;
  const landscape = instance.template.orientation === "LANDSCAPE";
  const [w, h] = landscape ? [1920, 1080] : [1080, 1920];
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  const lines = Object.entries(values).filter(([, v]) => v).map(([k, v], i) => `<text x="${w * 0.08}" y="${h * 0.3 + i * (h * 0.11)}" font-family="Inter, Arial, sans-serif" font-size="${i === 0 ? h * 0.08 : h * 0.05}" font-weight="${i === 0 ? 800 : 500}" fill="#ffffff">${esc(v)}<title>${esc(k)}</title></text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${lines.join("")}<text x="${w * 0.08}" y="${h * 0.92}" font-family="Inter, Arial, sans-serif" font-size="${h * 0.03}" fill="#94a3b8">${esc(instance.template.name)}</text></svg>`;
  const key = `${data.companyId}/templates/${instance.id}/${Date.now()}.svg`;
  try {
    await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: svg, ContentType: "image/svg+xml" }));
    await prisma.templateInstance.update({ where: { id: instance.id }, data: { outputKey: key } });
    emitToCompany(data.companyId, Events.mediaReady, { templateInstanceId: instance.id, status: "READY" });
  } catch (err) {
    logger.error({ err, instanceId: instance.id }, "template render failed");
    throw err;
  }
}
