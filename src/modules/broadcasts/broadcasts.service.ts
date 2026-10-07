import { nanoid } from "nanoid";
import type { z } from "zod";
import { bumpManifests, emitManifestChanged } from "../../core/assignments/content.js";
import { logActivity } from "../../core/audit/activity.js";
import type { AuthUser } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { withTransaction, type Tx } from "../../core/db/transaction.js";
import { NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { sha256Hex } from "../../core/media/process.js";
import { deleteObject, getObjectBuffer, headObject, presignGet, presignPut, putObject } from "../../core/storage/s3.js";
import { assertAudienceExists, audienceOf, audienceWhere, type TargetAudience } from "../../core/targeting/audience.js";
import type { Broadcast, Prisma } from "../../generated/prisma/client.js";
import { renderTemplate } from "../templates/templates.render.js";
import { templateField } from "../templates/templates.schemas.js";
import { effectiveValues, validateValues } from "../templates/templates.service.js";
import { BROADCAST_MIME, BROADCAST_PREFIX, type broadcastUploadBody, type createBroadcastBody, type updateBroadcastBody } from "./broadcasts.schemas.js";

export function isLive(b: Pick<Broadcast, "active" | "startsAt" | "endsAt">, now = new Date()): boolean {
  return b.active && b.startsAt <= now && (!b.endsAt || b.endsAt > now);
}

function statusOf(b: Broadcast, now = new Date()) {
  if (!b.active) return "PAUSED" as const;
  if (b.startsAt > now) return "SCHEDULED" as const;
  if (b.endsAt && b.endsAt <= now) return "ENDED" as const;
  return "LIVE" as const;
}

/** Paired screens at the locations an audience reaches. */
function screensWhere(audience: TargetAudience): Prisma.ScreenWhereInput {
  const paired: Prisma.ScreenWhereInput = { pairingStatus: "PAIRED" };
  if (audience.kind === "all") return paired;
  if (audience.kind === "companies") return { ...paired, companyId: { in: audience.companyIds } };
  return { ...paired, company: { categoryId: { in: audience.categoryIds } } };
}

/** Tells every screen the audiences reach to fetch a new manifest (after commit, per company). */
async function refreshScreens(audiences: TargetAudience[], work?: (tx: Tx) => Promise<unknown>) {
  const screens = await prisma.screen.findMany({ where: { OR: audiences.map(screensWhere) }, select: { id: true, companyId: true } });
  const bumped = await withTransaction(async (tx) => {
    await work?.(tx);
    return bumpManifests(screens.map((s) => s.id), tx);
  });
  const byCompany = new Map<string, typeof bumped>();
  for (const b of bumped) {
    const companyId = screens.find((s) => s.id === b.id)!.companyId;
    byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), b]);
  }
  for (const [companyId, list] of byCompany) emitManifestChanged(companyId, list);
}

async function toDto(b: Broadcast) {
  const audience = audienceOf(b.audience);
  return {
    id: b.id, title: b.title, source: b.source as "UPLOAD" | "TEMPLATE", templateId: b.templateId, type: b.type as "IMAGE" | "VIDEO", mimeType: b.mimeType, previewUrl: await presignGet(b.fileKey),
    displaySec: b.displaySec, audience, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt?.toISOString() ?? null, active: b.active, status: statusOf(b),
    screens: await prisma.screen.count({ where: screensWhere(audience) }), createdAt: b.createdAt.toISOString(),
  };
}

async function find(id: string) {
  const b = await prisma.broadcast.findUnique({ where: { id } });
  if (!b) throw new NotFoundError("Push");
  return b;
}

/** Renders a template with Head Office's values only; every required field needs one. */
async function renderForPush(templateId: string) {
  const t = await prisma.template.findUnique({ where: { id: templateId } });
  if (!t) throw new ValidationError("Template not found", [{ path: "body.templateId", message: "Choose a template" }], "TEMPLATE_NOT_FOUND");
  const fields = (t.fields as unknown[]).map((f) => templateField.parse(f));
  const missing = validateValues(fields, {});
  if (missing.length) throw new ValidationError(`Give every required field a Head Office value before pushing this template (${fields.filter((f) => missing.some((m) => m.path === f.key)).map((f) => f.label).join(", ")})`, [{ path: "body.templateId", message: "Some required fields have no Head Office value" }], "TEMPLATE_NEEDS_VALUES");
  const values = effectiveValues(fields, {});
  const images = new Map<string, Buffer>();
  for (const f of fields.filter((x) => x.type === "image" && values[x.key]?.startsWith("head-office/"))) images.set(f.key, await getObjectBuffer(values[f.key]!));
  const out = await renderTemplate({ orientation: t.orientation, fields, values, images });
  const key = `${BROADCAST_PREFIX}${nanoid(12)}/template.png`;
  await putObject(key, out.body, out.mimeType);
  return { key, mimeType: out.mimeType, type: "IMAGE" as const, sizeBytes: out.sizeBytes, checksum: out.checksum, width: out.width, height: out.height };
}

export const broadcastsService = {
  async list() {
    return Promise.all((await prisma.broadcast.findMany({ orderBy: { createdAt: "desc" } })).map(toDto));
  },

  async uploadUrl(body: z.infer<typeof broadcastUploadBody>) {
    const name = body.fileName.replace(/[^\w.\-() ]+/g, "_").slice(0, 120);
    const key = `${BROADCAST_PREFIX}${nanoid(12)}/${name}`;
    const expiresInSec = Math.min(6 * 3600, Math.max(15 * 60, Math.ceil(body.sizeBytes / 50_000)));
    return { key, uploadUrl: await presignPut(key, body.contentType, expiresInSec), expiresInSec };
  },

  async create(actor: AuthUser, body: z.infer<typeof createBroadcastBody>) {
    await assertAudienceExists(body.audience);
    let file: { key: string; mimeType: string; type: "IMAGE" | "VIDEO"; sizeBytes: number; checksum: string | null; width?: number; height?: number };
    if (body.templateId) file = await renderForPush(body.templateId);
    else {
      const key = body.fileKey!;
      const head = key.startsWith(BROADCAST_PREFIX) ? await headObject(key) : null;
      const type = head?.contentType ? BROADCAST_MIME[head.contentType as keyof typeof BROADCAST_MIME] : undefined;
      if (!head || !type) throw new ValidationError("Upload the file again; it was not found", [{ path: "body.fileKey", message: "Upload the file again" }], "UPLOAD_MISSING");
      if (type === "VIDEO" && !body.videoSec) throw new ValidationError("The video's length is needed", [{ path: "body.videoSec", message: "Required for a video" }], "VIDEO_LENGTH_REQUIRED");
      file = { key, mimeType: head.contentType!, type, sizeBytes: head.size, checksum: head.etag?.replace(/"/g, "") ?? null, width: body.width, height: body.height };
    }
    const data = {
      title: body.title, source: body.templateId ? "TEMPLATE" : "UPLOAD", templateId: body.templateId ?? null, fileKey: file.key, mimeType: file.mimeType, type: file.type, sizeBytes: file.sizeBytes,
      checksum: file.checksum ?? (body.templateId ? sha256Hex(Buffer.from(file.key)) : null), width: file.width ?? null, height: file.height ?? null,
      displaySec: file.type === "VIDEO" ? body.videoSec! : body.displaySec, audience: body.audience, startsAt: body.startsAt ?? new Date(), endsAt: body.endsAt ?? null, createdById: actor.id,
    };
    const live = isLive({ active: true, startsAt: data.startsAt, endsAt: data.endsAt });
    let created: Broadcast | undefined;
    const save = async (tx: Tx) => { created = await tx.broadcast.create({ data: { ...data, liveNow: live } }); };
    if (live) await refreshScreens([body.audience], save);
    else await withTransaction(save);
    await logActivity({ actor, action: "broadcast.created", resourceType: "broadcast", resourceId: created!.id, summary: `"${created!.title}" pushed to screens${live ? "" : " (scheduled)"}` });
    return toDto(created!);
  },

  async update(actor: AuthUser, id: string, body: z.infer<typeof updateBroadcastBody>) {
    const b = await find(id);
    if (body.audience) await assertAudienceExists(body.audience);
    const startsAt = body.startsAt ?? b.startsAt;
    const endsAt = body.endsAt === undefined ? b.endsAt : body.endsAt;
    if (endsAt && endsAt <= startsAt) throw new ValidationError("The end must be after the start", [{ path: "body.endsAt", message: "Must be after the start" }], "INVALID_WINDOW");
    const next = { title: body.title, displaySec: b.type === "VIDEO" ? undefined : body.displaySec, audience: body.audience, startsAt: body.startsAt, endsAt: body.endsAt, active: body.active };
    const willBeLive = isLive({ active: body.active ?? b.active, startsAt, endsAt });
    let updated: Broadcast | undefined;
    const save = async (tx: Tx) => { updated = await tx.broadcast.update({ where: { id }, data: { ...next, liveNow: willBeLive } }); };
    // Screens that had it and screens that will have it both need a new manifest.
    if (b.liveNow || willBeLive) await refreshScreens([audienceOf(b.audience), ...(body.audience ? [body.audience] : [])], save);
    else await withTransaction(save);
    const what = body.active === false ? "paused" : body.active === true && !b.active ? "resumed" : "updated";
    await logActivity({ actor, action: `broadcast.${what}`, resourceType: "broadcast", resourceId: id, summary: `"${updated!.title}" ${what}` });
    return toDto(updated!);
  },

  async remove(actor: AuthUser, id: string) {
    const b = await find(id);
    const drop = async (tx: Tx) => { await tx.broadcast.delete({ where: { id } }); };
    if (b.liveNow) await refreshScreens([audienceOf(b.audience)], drop);
    else await withTransaction(drop);
    await deleteObject(b.fileKey).catch(() => undefined);
    await logActivity({ actor, action: "broadcast.deleted", resourceType: "broadcast", resourceId: id, summary: `"${b.title}" taken off screens and deleted` });
  },

  /** Live pushes for one location, oldest first: what its screens add to each loop. */
  liveFor(companyId: string, categoryId: string | null, now = new Date()) {
    return prisma.broadcast.findMany({
      where: { AND: [{ active: true, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, audienceWhere({ companyId, categoryId }) as Prisma.BroadcastWhereInput] },
      orderBy: { startsAt: "asc" },
    });
  },
};

/**
 * Sweep: a push whose start or end time has passed since screens were last told gets them a new
 * manifest, so it appears and disappears on time without anyone saving anything.
 */
export async function broadcastWindowSweep(now = new Date()): Promise<number> {
  const all = await prisma.broadcast.findMany({ where: { OR: [{ liveNow: true }, { active: true, startsAt: { lte: now } }] } });
  const changed = all.filter((b) => b.liveNow !== isLive(b, now));
  for (const b of changed) await refreshScreens([audienceOf(b.audience)], (tx) => tx.broadcast.update({ where: { id: b.id }, data: { liveNow: !b.liveNow } }));
  return changed.length;
}
