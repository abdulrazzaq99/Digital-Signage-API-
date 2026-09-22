import { liveSchedules } from "../../core/assignments/content.js";
import { prisma } from "../../core/db/prisma.js";
import type { Tx } from "../../core/db/transaction.js";
import { NotFoundError } from "../../core/errors/AppError.js";
import { presignGet } from "../../core/storage/s3.js";
import type { AssignmentKind } from "../../generated/prisma/enums.js";

/** A file the player downloads once and plays by ID. */
interface FileRef {
  id: string;
  type: string;
  mimeType: string;
  storageKey: string;
  checksum: string | null;
  sizeBytes: bigint | number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  /** For a rendered PDF page: the PDF it came from and its page number. */
  sourceAssetId?: string;
  page?: number;
}

interface Item {
  assetId: string;
  position: number;
  durationSec: number;
}

interface Zone {
  index: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bindingKind: string | null;
  refId: string | null;
  items: Item[];
}

interface Content {
  name: string;
  items: Item[];
  layout: { presetId: string; zones: Zone[] } | null;
}

const pageSelect = { id: true, page: true, storageKey: true, mimeType: true, sizeBytes: true, checksum: true, width: true, height: true } as const;
const assetSelect = { id: true, type: true, mimeType: true, storageKey: true, checksum: true, sizeBytes: true, width: true, height: true, durationSec: true, derivatives: { where: { kind: "PDF_PAGE" as const }, orderBy: { page: "asc" as const }, select: pageSelect } } as const;
const itemsInclude = { items: { orderBy: { position: "asc" as const }, include: { asset: { select: assetSelect } } } };

type AssetRow = FileRef & { derivatives: { id: string; page: number | null; storageKey: string; mimeType: string | null; sizeBytes: number | null; checksum: string | null; width: number | null; height: number | null }[] };

/**
 * Turns playlist rows into playback items. A PDF becomes its rendered page images (one page, or
 * all of them in order), so players never render PDFs themselves. Positions are renumbered.
 */
function playable(rows: { asset: AssetRow; page?: number | null; durationSec: number }[], files: Map<string, FileRef>): Item[] {
  const out: Item[] = [];
  for (const row of rows) {
    const { derivatives, ...asset } = row.asset;
    const pages = asset.type === "PDF" ? derivatives.filter((d) => row.page == null || d.page === row.page) : [];
    if (!pages.length) {
      files.set(asset.id, asset);
      out.push({ assetId: asset.id, position: out.length, durationSec: row.durationSec });
      continue;
    }
    for (const d of pages) {
      files.set(d.id, { id: d.id, type: "IMAGE", mimeType: d.mimeType ?? "image/png", storageKey: d.storageKey, checksum: d.checksum, sizeBytes: d.sizeBytes ?? 0, width: d.width, height: d.height, durationSec: null, sourceAssetId: asset.id, page: d.page ?? undefined });
      out.push({ assetId: d.id, position: out.length, durationSec: row.durationSec });
    }
  }
  return out;
}

/** How long a media file bound straight to a layout zone shows before it repeats. */
const ZONE_MEDIA_SEC = 10;
const TEMPLATE_SEC = 15;

/** Resolves a playlist, layout or template instance to playable items, collecting its files. */
async function loadContent(tx: Tx, kind: AssignmentKind, refId: string, files: Map<string, FileRef>): Promise<Content | null> {
  const use = (f: FileRef) => (files.set(f.id, f), f.id);
  if (kind === "PLAYLIST") {
    const p = await tx.playlist.findUnique({ where: { id: refId }, include: itemsInclude });
    return p && { name: p.name, items: playable(p.items, files), layout: null };
  }
  if (kind === "LAYOUT") {
    const l = await tx.layout.findUnique({ where: { id: refId }, include: { zones: { orderBy: { index: "asc" }, include: { asset: { select: assetSelect }, playlist: { include: itemsInclude } } } } });
    if (!l) return null;
    const zones = l.zones.map((z) => ({
      index: z.index, name: z.name, x: z.x, y: z.y, w: z.w, h: z.h, bindingKind: z.bindingKind, refId: z.assetId ?? z.playlistId,
      items: playable(z.asset ? [{ asset: z.asset, durationSec: ZONE_MEDIA_SEC }] : (z.playlist?.items ?? []), files),
    }));
    return { name: l.name, items: [], layout: { presetId: l.presetId, zones } };
  }
  if (kind === "TEMPLATE_INSTANCE") {
    const t = await tx.templateInstance.findUnique({ where: { id: refId } });
    if (!t) return null;
    // The rendered output is addressed by the instance ID; a re-render bumps the version and the checksum.
    const items = t.outputKey ? [{ assetId: use({ id: t.id, type: "IMAGE", mimeType: t.outputMimeType ?? "image/png", storageKey: t.outputKey, checksum: t.outputChecksum, sizeBytes: t.outputSizeBytes ?? 0, width: t.outputWidth, height: t.outputHeight, durationSec: null }), position: 0, durationSec: TEMPLATE_SEC }] : [];
    return { name: t.name, items, layout: null };
  }
  return null;
}

/**
 * Desired state for one screen, read from a single snapshot so the content always matches
 * `version`. `assets[]` lists every file the screen needs (its assignment and every live
 * schedule) exactly once; `items`, `layout.zones[].items` and `schedule[].items` say what to play.
 */
export async function buildManifest(screenId: string) {
  const files = new Map<string, FileRef>();
  const data = await prisma.$transaction(
    async (tx) => {
      const screen = await tx.screen.findUnique({ where: { id: screenId }, include: { assignment: true } });
      if (!screen) throw new NotFoundError("Screen");
      const groupIds = (await tx.screenGroupMember.findMany({ where: { screenId }, select: { groupId: true } })).map((g) => g.groupId);
      const schedules = await tx.schedule.findMany({
        where: { AND: [{ OR: [{ targetKind: "SCREEN", targetId: screenId }, { targetKind: "GROUP", targetId: { in: groupIds } }] }, liveSchedules()] },
        include: { playlist: { include: itemsInclude } },
        orderBy: { startsAt: "asc" },
      });

      let assignment: { kind: AssignmentKind; refId: string; name: string } | null = null;
      let content: Content | null = null;
      let canvas: { setId: string; position: number; total: number; activateAt: string | null; viewport: { x: number; y: number; width: number; height: number }; content: { kind: AssignmentKind; refId: string } | null } | null = null;
      const a = screen.assignment;
      if (a?.kind === "CANVAS") {
        const set = await tx.canvasSet.findUnique({ where: { id: a.refId }, include: { members: { select: { screenId: true, position: true }, orderBy: { position: "asc" } } } });
        const member = set?.members.find((m) => m.screenId === screenId);
        if (set && member) {
          assignment = { kind: "CANVAS", refId: set.id, name: set.name };
          if (set.contentKind && set.contentRef && set.contentKind !== "CANVAS") content = await loadContent(tx, set.contentKind, set.contentRef, files);
          // Members sit left to right in position order; each shows its slice of the full composition.
          const total = set.members.length;
          const slot = set.members.indexOf(member);
          canvas = { setId: set.id, position: member.position, total, activateAt: set.activateAt?.toISOString() ?? null, viewport: { x: slot / total, y: 0, width: 1 / total, height: 1 }, content: set.contentKind && set.contentRef ? { kind: set.contentKind, refId: set.contentRef } : null };
        }
      } else if (a) {
        content = await loadContent(tx, a.kind, a.refId, files);
        if (content) assignment = { kind: a.kind, refId: a.refId, name: content.name };
      }

      const schedule = schedules.map((s) => ({
        id: s.id, playlistId: s.playlistId, name: s.playlist.name, targetKind: s.targetKind, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt?.toISOString() ?? null, timezone: s.timezone,
        items: playable(s.playlist.items, files),
      }));
      return { screen, assignment, content, canvas, schedule };
    },
    { isolationLevel: "RepeatableRead" },
  );

  const { screen } = data;
  const assets = await Promise.all(
    [...files.values()].map(async (f) => ({ id: f.id, type: f.type, mimeType: f.mimeType, url: await presignGet(f.storageKey), checksum: f.checksum, sizeBytes: Number(f.sizeBytes), width: f.width, height: f.height, durationSec: f.durationSec, sourceAssetId: f.sourceAssetId ?? null, page: f.page ?? null })),
  );
  return {
    version: screen.manifestVersion, screenId: screen.id, companyId: screen.companyId, orientation: screen.orientation, generatedAt: new Date().toISOString(),
    activateAt: screen.assignment?.activateAt?.toISOString() ?? null,
    assignment: data.assignment,
    items: data.content?.items ?? [],
    layout: data.content?.layout ?? null,
    canvas: data.canvas,
    schedule: data.schedule,
    assets,
  };
}
