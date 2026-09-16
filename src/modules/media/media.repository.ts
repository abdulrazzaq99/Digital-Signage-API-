import { prisma } from "../../core/db/prisma.js";
import type { Tx } from "../../core/db/transaction.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const mediaInclude = {
  uploadedBy: { select: { name: true } },
  playlistItems: { select: { playlist: { select: { id: true, name: true } } } },
  derivatives: { where: { kind: "THUMBNAIL" }, select: { storageKey: true }, take: 1 },
} satisfies Prisma.MediaAssetInclude;

export type MediaRow = Prisma.MediaAssetGetPayload<{ include: typeof mediaInclude }>;

export const mediaRepository = {
  list: (where: Prisma.MediaAssetWhereInput, skip: number, take: number) => Promise.all([prisma.mediaAsset.findMany({ where, include: mediaInclude, orderBy: { createdAt: "desc" }, skip, take }), prisma.mediaAsset.count({ where })]),
  findScoped: (companyId: string | undefined, id: string) => prisma.mediaAsset.findFirst({ where: { id, ...(companyId ? { companyId } : {}) }, include: mediaInclude }),
  create: (data: Prisma.MediaAssetUncheckedCreateInput) => prisma.mediaAsset.create({ data, include: mediaInclude }),
  update: (id: string, data: Prisma.MediaAssetUncheckedUpdateInput, tx?: Tx) => (tx ?? prisma).mediaAsset.update({ where: { id }, data, include: mediaInclude }),
  delete: (id: string, tx?: Tx) => (tx ?? prisma).mediaAsset.delete({ where: { id } }),
  removeFromPlaylists: async (assetId: string, tx: Tx) => {
    const items = await tx.playlistItem.findMany({ where: { assetId }, select: { playlistId: true } });
    await tx.playlistItem.deleteMany({ where: { assetId } });
    // close position gaps so (playlistId, position) stays contiguous
    for (const playlistId of new Set(items.map((i) => i.playlistId))) {
      const rest = await tx.playlistItem.findMany({ where: { playlistId }, orderBy: { position: "asc" } });
      for (const [i, it] of rest.entries()) if (it.position !== i) await tx.playlistItem.update({ where: { id: it.id }, data: { position: i } });
    }
    return [...new Set(items.map((i) => i.playlistId))];
  },
  stats: async (companyId: string) => {
    const [total, ready, processing, failed, bytes] = await Promise.all([
      prisma.mediaAsset.count({ where: { companyId } }),
      prisma.mediaAsset.count({ where: { companyId, status: "READY" } }),
      prisma.mediaAsset.count({ where: { companyId, status: { in: ["PROCESSING", "UPLOADING"] } } }),
      prisma.mediaAsset.count({ where: { companyId, status: "FAILED" } }),
      prisma.mediaAsset.aggregate({ where: { companyId, status: "READY" }, _sum: { sizeBytes: true } }),
    ]);
    return { total, ready, processing, failed, storageBytes: Number(bytes._sum.sizeBytes ?? 0) };
  },
};
