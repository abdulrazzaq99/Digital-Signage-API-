import { prisma } from "../../core/db/prisma.js";
import type { Tx } from "../../core/db/transaction.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const playlistInclude = {
  items: { orderBy: { position: "asc" as const }, include: { asset: { select: { id: true, name: true, type: true, status: true, storageKey: true, derivatives: { where: { kind: "THUMBNAIL" as const }, select: { storageKey: true }, take: 1 } } } } },
} satisfies Prisma.PlaylistInclude;

export type PlaylistRow = Prisma.PlaylistGetPayload<{ include: typeof playlistInclude }>;

export const playlistsRepository = {
  list: (where: Prisma.PlaylistWhereInput, skip: number, take: number) => Promise.all([prisma.playlist.findMany({ where, include: playlistInclude, orderBy: { updatedAt: "desc" }, skip, take }), prisma.playlist.count({ where })]),
  findScoped: (companyId: string | undefined, id: string, tx?: Tx) => (tx ?? prisma).playlist.findFirst({ where: { id, ...(companyId ? { companyId } : {}) }, include: playlistInclude }),
  create: (data: Prisma.PlaylistUncheckedCreateInput, tx?: Tx) => (tx ?? prisma).playlist.create({ data, include: playlistInclude }),
  update: (id: string, data: Prisma.PlaylistUncheckedUpdateInput, tx?: Tx) => (tx ?? prisma).playlist.update({ where: { id }, data, include: playlistInclude }),
  delete: (id: string, tx?: Tx) => (tx ?? prisma).playlist.delete({ where: { id } }),
  /**
   * Syncs the item rows to `items` while keeping existing item IDs stable: rows whose id is
   * present are updated in place, rows missing from the list are deleted, entries without an
   * id are created. Positions are parked on negative values first to avoid unique collisions.
   */
  syncItems: async (playlistId: string, items: { id?: string; assetId: string; durationSec: number; page?: number | null }[], tx: Tx) => {
    const keep = items.map((i) => i.id).filter((id): id is string => !!id);
    await tx.playlistItem.deleteMany({ where: { playlistId, ...(keep.length ? { id: { notIn: keep } } : {}) } });
    for (const id of keep) await tx.playlistItem.update({ where: { id }, data: { position: -1 - keep.indexOf(id) } });
    for (const [position, it] of items.entries()) {
      if (it.id) await tx.playlistItem.update({ where: { id: it.id }, data: { position, durationSec: it.durationSec, assetId: it.assetId, page: it.page ?? null } });
      else await tx.playlistItem.create({ data: { playlistId, position, assetId: it.assetId, durationSec: it.durationSec, page: it.page ?? null } });
    }
  },
  assetsInCompany: (companyId: string, ids: string[], tx?: Tx) => (tx ?? prisma).mediaAsset.findMany({ where: { companyId, id: { in: ids }, status: "READY" }, select: { id: true, type: true, pages: true, durationSec: true } }),
  assignedScreens: async (playlistIds: string[]) => {
    const rows = await prisma.screenAssignment.findMany({ where: { kind: "PLAYLIST", refId: { in: playlistIds } }, include: { screen: { select: { id: true, name: true } } } });
    const map = new Map<string, { id: string; name: string }[]>();
    for (const r of rows) map.set(r.refId, [...(map.get(r.refId) ?? []), r.screen]);
    return map;
  },
};
