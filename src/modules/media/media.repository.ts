import { prisma } from "../../core/db/prisma.js";
import type { Tx } from "../../core/db/transaction.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const mediaInclude = {
  uploadedBy: { select: { name: true } },
  playlistItems: { select: { playlist: { select: { id: true, name: true } } } },
  derivatives: { where: { kind: "THUMBNAIL" }, select: { storageKey: true }, take: 1 },
} satisfies Prisma.MediaAssetInclude;

export type MediaRow = Prisma.MediaAssetGetPayload<{ include: typeof mediaInclude }>;

/** One place a media file is used. */
export interface MediaUsage {
  kind: "PLAYLIST" | "LAYOUT" | "TEMPLATE_INSTANCE" | "CAMPAIGN" | "OFFER";
  id: string;
  name: string;
}

const unique = (rows: MediaUsage[]) => [...new Map(rows.map((r) => [`${r.kind}:${r.id}`, r])).values()];

export const mediaRepository = {
  /**
   * Everywhere the asset is referenced: playlist items, layout zones, template-instance image values
   * (stored by asset ID), and campaign artwork or offer images (stored by storage key). Canvases show
   * a playlist, layout or template, never media directly, so they are covered through those.
   */
  usage: async (asset: { id: string; companyId: string; storageKey: string }): Promise<MediaUsage[]> => {
    const [items, zones, templates, campaigns, offers] = await Promise.all([
      prisma.playlistItem.findMany({ where: { assetId: asset.id }, select: { playlist: { select: { id: true, name: true } } } }),
      prisma.layoutZone.findMany({ where: { assetId: asset.id }, select: { layout: { select: { id: true, name: true } } } }),
      prisma.$queryRaw<{ id: string; name: string }[]>`SELECT "id", "name" FROM "TemplateInstance" WHERE "companyId" = ${asset.companyId} AND EXISTS (SELECT 1 FROM jsonb_each_text("values") AS v WHERE v.value = ${asset.id})`,
      prisma.scratchCampaign.findMany({ where: { artworkKey: asset.storageKey }, select: { id: true, title: true } }),
      prisma.offer.findMany({ where: { imageKey: asset.storageKey }, select: { id: true, title: true } }),
    ]);
    return unique([
      ...items.map((i) => ({ kind: "PLAYLIST" as const, ...i.playlist })),
      ...zones.map((z) => ({ kind: "LAYOUT" as const, ...z.layout })),
      ...templates.map((t) => ({ kind: "TEMPLATE_INSTANCE" as const, id: t.id, name: t.name })),
      ...campaigns.map((c) => ({ kind: "CAMPAIGN" as const, id: c.id, name: c.title })),
      ...offers.map((o) => ({ kind: "OFFER" as const, id: o.id, name: o.title })),
    ]);
  },

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
