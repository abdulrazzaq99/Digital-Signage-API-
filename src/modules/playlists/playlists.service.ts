import type { z } from "zod";
import { changeContent } from "../../core/assignments/content.js";
import { emitAssignmentUpdated, publishAssignment } from "../../core/assignments/publish.js";
import { canvasesShowing } from "../../core/assignments/refs.js";
import { logActivity } from "../../core/audit/activity.js";
import { requireCompanyId, tenantWhere, type AuthUser, type TenantScope } from "../../core/auth/scope.js";
import { withTransaction, type Tx } from "../../core/db/transaction.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import { assertNameFree, freeCopyName } from "../../core/validation/names.js";
import { presignGet } from "../../core/storage/s3.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { playlistsRepository as repo, type PlaylistRow } from "./playlists.repository.js";
import type { addItemBody, createPlaylistBody, listPlaylistsQuery, publishBody, reorderBody, updateItemBody, updatePlaylistBody } from "./playlists.schemas.js";

const DEFAULT_DURATION = { IMAGE: 10, VIDEO: 30, PDF: 15 } as const;

async function toDto(p: PlaylistRow, assigned: { id: string; name: string }[] = [], withItems = true) {
  const items = withItems
    ? await Promise.all(p.items.map(async (it) => ({ id: it.id, position: it.position, durationSec: it.durationSec, page: it.page, asset: { id: it.asset.id, name: it.asset.name, type: it.asset.type, status: it.asset.status, thumbnailUrl: it.asset.derivatives[0]?.storageKey ? await presignGet(it.asset.derivatives[0].storageKey) : it.asset.type === "IMAGE" ? await presignGet(it.asset.storageKey) : null } })))
    : undefined;
  return { id: p.id, name: p.name, status: p.status, version: p.version, itemCount: p.items.length, totalDurationSec: p.items.reduce((a, b) => a + b.durationSec, 0), assignedTo: assigned, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), ...(items ? { items } : {}) };
}

type ItemInput = { id?: string; assetId: string; durationSec?: number; page?: number | null };

async function assertAssets(companyId: string, items: ItemInput[], tx?: Tx) {
  if (!items.length) return [];
  const found = new Map((await repo.assetsInCompany(companyId, items.map((i) => i.assetId), tx)).map((a) => [a.id, a]));
  const missing = items.filter((i) => !found.has(i.assetId));
  if (missing.length) throw new ValidationError("One or more media items are missing, not ready, or belong to another company", { assetIds: missing.map((m) => m.assetId) }, "ASSET_NOT_FOUND");
  const badPage = items.filter((i) => i.page != null && (found.get(i.assetId)!.type !== "PDF" || i.page > (found.get(i.assetId)!.pages ?? 0)));
  if (badPage.length) throw new ValidationError("A page can only be picked from a PDF, and must exist in it", { assetIds: badPage.map((i) => i.assetId) }, "INVALID_PAGE");
  // Videos default to their own length (spec 6.2); images and PDF pages to a fixed time.
  return items.map((i) => {
    const a = found.get(i.assetId)!;
    return { id: i.id, assetId: i.assetId, page: i.page ?? null, durationSec: i.durationSec ?? (a.type === "VIDEO" && a.durationSec ? a.durationSec : DEFAULT_DURATION[a.type]) };
  });
}

const existingItems = (p: PlaylistRow) => p.items.map((i) => ({ id: i.id, assetId: i.assetId, durationSec: i.durationSec, page: i.page }));

export const playlistsService = {
  async list(scope: TenantScope, q: z.infer<typeof listPlaylistsQuery>) {
    const where: Prisma.PlaylistWhereInput = { ...tenantWhere(scope), ...(q.status ? { status: q.status } : {}), ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}) };
    const { skip, take } = paginate(q);
    const [rows, total] = await repo.list(where, skip, take);
    const assigned = await repo.assignedScreens(rows.map((r) => r.id));
    return { data: await Promise.all(rows.map((r) => toDto(r, assigned.get(r.id) ?? [], false))), meta: pageMeta(q, total) };
  },

  async get(scope: TenantScope, id: string) {
    const p = await repo.findScoped(scope.companyId, id);
    if (!p) throw new NotFoundError("Playlist");
    return toDto(p, (await repo.assignedScreens([id])).get(id) ?? []);
  },

  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createPlaylistBody>) {
    const companyId = requireCompanyId(scope);
    await assertNameFree("playlist", body.name, { companyId });
    const p = await withTransaction(async (tx) => {
      const items = await assertAssets(companyId, body.items, tx);
      const created = await repo.create({ companyId, name: body.name }, tx);
      await repo.syncItems(created.id, items, tx);
      return repo.findScoped(companyId, created.id, tx);
    });
    await logActivity({ companyId, actor, action: "playlist.created", resourceType: "playlist", resourceId: p!.id, summary: `Playlist "${p!.name}" created` });
    return toDto(p!);
  },

  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updatePlaylistBody>) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Playlist");
    await assertNameFree("playlist", body.name, { companyId: existing.companyId, excludeId: id });
    const p = await changeContent(existing.companyId, { playlistIds: [id] }, async (tx) => {
      if (body.items) await repo.syncItems(id, await assertAssets(existing.companyId, body.items, tx), tx);
      await repo.update(id, { name: body.name }, tx);
      return repo.findScoped(existing.companyId, id, tx);
    });
    await logActivity({ companyId: existing.companyId, actor, action: "playlist.updated", resourceType: "playlist", resourceId: id, summary: `Playlist "${p!.name}" updated` });
    return toDto(p!, (await repo.assignedScreens([id])).get(id) ?? []);
  },

  async remove(actor: AuthUser, scope: TenantScope, id: string) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Playlist");
    const assigned = (await repo.assignedScreens([id])).get(id) ?? [];
    if (assigned.length) throw new ConflictError(`Playlist is assigned to ${assigned.length} screen${assigned.length > 1 ? "s" : ""}; publish other content first`, "PLAYLIST_IN_USE", { screens: assigned });
    // A canvas or layout zone showing it would silently go blank on its screens.
    const [canvases, layouts] = await Promise.all([canvasesShowing(existing.companyId, "PLAYLIST", id), repo.layoutsShowing(existing.companyId, id)]);
    if (canvases.length || layouts.length) throw new ConflictError(`Playlist is shown by ${[...canvases.map((c) => `canvas "${c.name}"`), ...layouts.map((l) => `layout "${l.name}"`)].join(", ")}; remove it there first`, "IN_USE", { canvases, layouts });
    // Deleting would silently cancel what is on the calendar; past schedules are history and go with it.
    const upcoming = await repo.upcomingSchedules(id);
    if (upcoming.length) throw new ConflictError(`Playlist has ${upcoming.length} current or upcoming schedule${upcoming.length > 1 ? "s" : ""}; delete ${upcoming.length > 1 ? "them" : "it"} first`, "PLAYLIST_SCHEDULED", { schedules: upcoming.map((s) => ({ id: s.id, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt?.toISOString() ?? null })) });
    // Its past schedules go with it, so screens still listing them get a new manifest.
    await changeContent(existing.companyId, { playlistIds: [id] }, (tx) => repo.delete(id, tx));
    await logActivity({ companyId: existing.companyId, actor, action: "playlist.deleted", resourceType: "playlist", resourceId: id, summary: `Playlist "${existing.name}" deleted` });
  },

  async duplicate(actor: AuthUser, scope: TenantScope, id: string) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Playlist");
    const copy = await withTransaction(async (tx) => {
      const created = await repo.create({ companyId: existing.companyId, name: await freeCopyName("playlist", existing.name, { companyId: existing.companyId, db: tx }) }, tx);
      await repo.syncItems(created.id, existing.items.map((i) => ({ assetId: i.assetId, durationSec: i.durationSec, page: i.page })), tx);
      return repo.findScoped(existing.companyId, created.id, tx);
    });
    await logActivity({ companyId: existing.companyId, actor, action: "playlist.duplicated", resourceType: "playlist", resourceId: copy!.id, summary: `Playlist "${existing.name}" duplicated` });
    return toDto(copy!);
  },

  async addItem(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof addItemBody>) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Playlist");
    const [item] = await assertAssets(existing.companyId, [body]);
    const items: ItemInput[] = existingItems(existing);
    items.splice(Math.min(body.position ?? items.length, items.length), 0, item!);
    const p = await changeContent(existing.companyId, { playlistIds: [id] }, async (tx) => { await repo.syncItems(id, items as { id?: string; assetId: string; durationSec: number; page: number | null }[], tx); return repo.findScoped(existing.companyId, id, tx); });
    return toDto(p!);
  },

  async updateItem(actor: AuthUser, scope: TenantScope, id: string, itemId: string, body: z.infer<typeof updateItemBody>) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Playlist");
    if (!existing.items.some((i) => i.id === itemId)) throw new NotFoundError("Playlist item");
    const items = existingItems(existing).map((i) => ({ ...i, durationSec: i.id === itemId ? body.durationSec : i.durationSec }));
    const p = await changeContent(existing.companyId, { playlistIds: [id] }, async (tx) => { await repo.syncItems(id, items, tx); return repo.findScoped(existing.companyId, id, tx); });
    return toDto(p!);
  },

  async removeItem(actor: AuthUser, scope: TenantScope, id: string, itemId: string) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Playlist");
    if (!existing.items.some((i) => i.id === itemId)) throw new NotFoundError("Playlist item");
    const items = existingItems(existing).filter((i) => i.id !== itemId);
    const p = await changeContent(existing.companyId, { playlistIds: [id] }, async (tx) => { await repo.syncItems(id, items, tx); return repo.findScoped(existing.companyId, id, tx); });
    return toDto(p!);
  },

  /** `itemIds` must be a permutation of the current items. */
  async reorder(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof reorderBody>) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Playlist");
    const current = new Map(existing.items.map((i) => [i.id, i]));
    const unique = new Set(body.itemIds);
    if (unique.size !== body.itemIds.length || unique.size !== current.size || body.itemIds.some((i) => !current.has(i))) throw new ValidationError("itemIds must contain every current item exactly once", undefined, "INVALID_ORDER");
    const items = body.itemIds.map((i) => ({ id: i, assetId: current.get(i)!.assetId, durationSec: current.get(i)!.durationSec, page: current.get(i)!.page }));
    const p = await changeContent(existing.companyId, { playlistIds: [id] }, async (tx) => { await repo.syncItems(id, items, tx); return repo.findScoped(existing.companyId, id, tx); });
    return toDto(p!);
  },

  async publish(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof publishBody>) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Playlist");
    if (!existing.items.length) throw new ValidationError("Playlist has no items", undefined, "PLAYLIST_EMPTY");
    const publishInput = { actor, companyId: existing.companyId, kind: "PLAYLIST" as const, refId: id, refName: existing.name, target: body };
    const result = await withTransaction(async (tx) => {
      const r = await publishAssignment({ ...publishInput, tx });
      await repo.update(id, { status: "PUBLISHED", version: { increment: 1 } }, tx);
      return r;
    });
    // Emitted after the commit so players fetching the manifest see the new version.
    emitAssignmentUpdated(publishInput, result);
    return result;
  },
};
