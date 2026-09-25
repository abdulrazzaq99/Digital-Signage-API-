import type { z } from "zod";
import { changeContent } from "../../core/assignments/content.js";
import { publishAssignment } from "../../core/assignments/publish.js";
import { canvasesShowing } from "../../core/assignments/refs.js";
import { logActivity } from "../../core/audit/activity.js";
import { requireCompanyId, type AuthUser, type TenantScope } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { bindZoneBody, createLayoutBody, publishBody } from "./layouts.schemas.js";

const include = { zones: { orderBy: { index: "asc" as const }, include: { asset: { select: { id: true, name: true } }, playlist: { select: { id: true, name: true } } } } } satisfies Prisma.LayoutInclude;
type LayoutRow = Prisma.LayoutGetPayload<{ include: typeof include }>;

function toDto(l: LayoutRow) {
  const zones = l.zones.map((z) => ({ index: z.index, name: z.name, x: z.x, y: z.y, w: z.w, h: z.h, bindingKind: z.bindingKind, binding: z.asset ?? z.playlist ?? null }));
  return { id: l.id, presetId: l.presetId, name: l.name, isPreset: l.isPreset, zones, ready: zones.every((z) => z.binding), createdAt: l.createdAt.toISOString() };
}

async function findScoped(companyId: string, id: string) {
  const l = await prisma.layout.findFirst({ where: { id, companyId, isPreset: false }, include });
  if (!l) throw new NotFoundError("Layout");
  return l;
}

export const layoutsService = {
  presets: async () => (await prisma.layout.findMany({ where: { isPreset: true }, include, orderBy: { createdAt: "asc" } })).map(toDto),

  async list(scope: TenantScope) {
    return (await prisma.layout.findMany({ where: { companyId: requireCompanyId(scope), isPreset: false }, include, orderBy: { updatedAt: "desc" } })).map(toDto);
  },

  async get(scope: TenantScope, id: string) {
    return toDto(await findScoped(requireCompanyId(scope), id));
  },

  /** Creates a company layout by copying the preset's fixed zone geometry. Geometry is never editable. */
  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createLayoutBody>) {
    const companyId = requireCompanyId(scope);
    const preset = await prisma.layout.findFirst({ where: { isPreset: true, presetId: body.presetId }, include });
    if (!preset) throw new ValidationError("Unknown layout preset", undefined, "PRESET_NOT_FOUND");
    const l = await prisma.layout.create({ data: { companyId, presetId: preset.presetId, name: body.name, isPreset: false, zones: { create: preset.zones.map((z) => ({ index: z.index, name: z.name, x: z.x, y: z.y, w: z.w, h: z.h })) } }, include });
    await logActivity({ companyId, actor, action: "layout.created", resourceType: "layout", resourceId: l.id, summary: `Layout "${l.name}" created from ${preset.name}` });
    return toDto(l);
  },

  async bindZone(actor: AuthUser, scope: TenantScope, id: string, index: number, body: z.infer<typeof bindZoneBody>) {
    const companyId = requireCompanyId(scope);
    const l = await findScoped(companyId, id);
    const zone = l.zones.find((z) => z.index === index);
    if (!zone) throw new NotFoundError("Zone");
    if (body.bindingKind === "MEDIA") {
      const ok = await prisma.mediaAsset.count({ where: { id: body.refId, companyId, status: "READY" } });
      if (!ok) throw new ValidationError("Media not found or not ready", undefined, "ASSET_NOT_FOUND");
      await changeContent(companyId, { layoutIds: [id] }, (tx) => tx.layoutZone.update({ where: { id: zone.id }, data: { bindingKind: "MEDIA", assetId: body.refId, playlistId: null } }));
    } else {
      const ok = await prisma.playlist.count({ where: { id: body.refId, companyId } });
      if (!ok) throw new ValidationError("Playlist not found", undefined, "PLAYLIST_NOT_FOUND");
      await changeContent(companyId, { layoutIds: [id] }, (tx) => tx.layoutZone.update({ where: { id: zone.id }, data: { bindingKind: "PLAYLIST", playlistId: body.refId, assetId: null } }));
    }
    return toDto(await findScoped(companyId, id));
  },

  async unbindZone(scope: TenantScope, id: string, index: number) {
    const companyId = requireCompanyId(scope);
    const l = await findScoped(companyId, id);
    const zone = l.zones.find((z) => z.index === index);
    if (!zone) throw new NotFoundError("Zone");
    await changeContent(companyId, { layoutIds: [id] }, (tx) => tx.layoutZone.update({ where: { id: zone.id }, data: { bindingKind: null, assetId: null, playlistId: null } }));
    return toDto(await findScoped(companyId, id));
  },

  async remove(actor: AuthUser, scope: TenantScope, id: string) {
    const companyId = requireCompanyId(scope);
    const l = await findScoped(companyId, id);
    const assigned = await prisma.screenAssignment.count({ where: { kind: "LAYOUT", refId: id } });
    if (assigned) throw new ConflictError(`Layout is live on ${assigned} screen${assigned > 1 ? "s" : ""}`, "LAYOUT_IN_USE");
    const canvases = await canvasesShowing(companyId, "LAYOUT", id);
    if (canvases.length) throw new ConflictError(`Layout is shown by ${canvases.map((c) => `canvas "${c.name}"`).join(", ")}; remove it there first`, "IN_USE", { canvases });
    await prisma.layout.delete({ where: { id } });
    await logActivity({ companyId, actor, action: "layout.deleted", resourceType: "layout", resourceId: id, summary: `Layout "${l.name}" deleted` });
  },

  async publish(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof publishBody>) {
    const companyId = requireCompanyId(scope);
    const l = await findScoped(companyId, id);
    const missing = l.zones.filter((z) => !z.bindingKind).map((z) => z.name);
    if (missing.length) throw new ValidationError(`Required zones not yet assigned: ${missing.join(", ")}`, { zones: missing }, "ZONES_UNASSIGNED");
    return publishAssignment({ actor, companyId, kind: "LAYOUT", refId: id, refName: l.name, target: body });
  },
};
