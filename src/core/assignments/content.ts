import { prisma } from "../db/prisma.js";
import { withTransaction, type Tx } from "../db/transaction.js";
import { Events } from "../realtime/events.js";
import { emitToCompany, emitToScreen } from "../realtime/server.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { AssignmentKind } from "../../generated/prisma/enums.js";

/** Schedules that still appear in manifests: open-ended, or ended less than a day ago. */
export function liveSchedules(): Prisma.ScheduleWhereInput {
  return { OR: [{ endsAt: null }, { endsAt: { gte: new Date(Date.now() - 24 * 3600_000) } }] };
}

/** Content whose change can alter what screens are told to play. */
export interface ContentRef {
  playlistIds?: string[];
  layoutIds?: string[];
  templateInstanceIds?: string[];
  canvasIds?: string[];
  assetIds?: string[];
  scheduleIds?: string[];
  /** Groups whose members' schedules may change (membership edits, group deletion). */
  groupIds?: string[];
  /** Screens whose own manifest fields changed (orientation, group). */
  screenIds?: string[];
}

export interface BumpedScreen {
  id: string;
  version: number;
  kind: AssignmentKind | null;
  refId: string | null;
  activateAt: Date | null;
}

const ids = (s: Set<string>) => [...s];

/**
 * Paired screens of the company whose manifest includes any of `ref`: as the direct assignment,
 * through a layout zone, as a canvas's content, or through a live schedule.
 */
export async function affectedScreens(companyId: string, ref: ContentRef, db: Tx = prisma): Promise<string[]> {
  const playlists = new Set(ref.playlistIds);
  const layouts = new Set(ref.layoutIds);
  const templates = new Set(ref.templateInstanceIds);
  const canvases = new Set(ref.canvasIds);
  const groups = new Set<string>();
  const screens = new Set(ref.screenIds);

  if (ref.assetIds?.length) {
    for (const i of await db.playlistItem.findMany({ where: { assetId: { in: ref.assetIds } }, select: { playlistId: true } })) playlists.add(i.playlistId);
    for (const z of await db.layoutZone.findMany({ where: { assetId: { in: ref.assetIds } }, select: { layoutId: true } })) layouts.add(z.layoutId);
  }
  if (playlists.size) for (const z of await db.layoutZone.findMany({ where: { playlistId: { in: ids(playlists) } }, select: { layoutId: true } })) layouts.add(z.layoutId);

  const canvasContent: Prisma.CanvasSetWhereInput[] = [];
  if (playlists.size) canvasContent.push({ contentKind: "PLAYLIST", contentRef: { in: ids(playlists) } });
  if (layouts.size) canvasContent.push({ contentKind: "LAYOUT", contentRef: { in: ids(layouts) } });
  if (templates.size) canvasContent.push({ contentKind: "TEMPLATE_INSTANCE", contentRef: { in: ids(templates) } });
  if (canvasContent.length) for (const c of await db.canvasSet.findMany({ where: { companyId, OR: canvasContent }, select: { id: true } })) canvases.add(c.id);

  const assigned: Prisma.ScreenAssignmentWhereInput[] = [];
  if (playlists.size) assigned.push({ kind: "PLAYLIST", refId: { in: ids(playlists) } });
  if (layouts.size) assigned.push({ kind: "LAYOUT", refId: { in: ids(layouts) } });
  if (templates.size) assigned.push({ kind: "TEMPLATE_INSTANCE", refId: { in: ids(templates) } });
  if (canvases.size) assigned.push({ kind: "CANVAS", refId: { in: ids(canvases) } });
  if (assigned.length) for (const a of await db.screenAssignment.findMany({ where: { OR: assigned }, select: { screenId: true } })) screens.add(a.screenId);

  const scheduled: Prisma.ScheduleWhereInput[] = [];
  if (playlists.size) scheduled.push({ playlistId: { in: ids(playlists) } });
  if (ref.scheduleIds?.length) scheduled.push({ id: { in: ref.scheduleIds } });
  if (ref.groupIds?.length) scheduled.push({ targetKind: "GROUP", targetId: { in: ref.groupIds } });
  if (scheduled.length) {
    const rows = await db.schedule.findMany({ where: { AND: [{ companyId }, liveSchedules(), { OR: scheduled }] }, select: { targetKind: true, targetId: true } });
    for (const s of rows) (s.targetKind === "SCREEN" ? screens : groups).add(s.targetId);
  }
  if (groups.size) for (const m of await db.screenGroupMember.findMany({ where: { groupId: { in: ids(groups) } }, select: { screenId: true } })) screens.add(m.screenId);

  if (!screens.size) return [];
  return (await db.screen.findMany({ where: { id: { in: ids(screens) }, companyId, pairingStatus: "PAIRED" }, select: { id: true } })).map((s) => s.id);
}

/**
 * Moves the screens to a new manifest version. Canvas members must preload again before they
 * count as ready.
 */
export async function bumpManifests(screenIds: string[], tx: Tx): Promise<BumpedScreen[]> {
  if (!screenIds.length) return [];
  await tx.screen.updateMany({ where: { id: { in: screenIds } }, data: { manifestVersion: { increment: 1 }, syncState: "PENDING" } });
  await tx.canvasMember.updateMany({ where: { screenId: { in: screenIds } }, data: { ready: false } });
  const rows = await tx.screen.findMany({ where: { id: { in: screenIds } }, select: { id: true, manifestVersion: true, assignment: { select: { kind: true, refId: true, activateAt: true } } } });
  return rows.map((r) => ({ id: r.id, version: r.manifestVersion, kind: r.assignment?.kind ?? null, refId: r.assignment?.refId ?? null, activateAt: r.assignment?.activateAt ?? null }));
}

/** Tells players to fetch their new manifest and dashboards to refresh. Call only after commit. */
export function emitManifestChanged(companyId: string, screens: BumpedScreen[]): void {
  if (!screens.length) return;
  for (const s of screens) emitToScreen(s.id, Events.assignmentUpdated, { screenId: s.id, version: s.version, kind: s.kind, refId: s.refId, activateAt: s.activateAt?.toISOString() ?? null });
  emitToCompany(companyId, Events.assignmentUpdated, { kind: null, refId: null, screenIds: screens.map((s) => s.id) });
}

/**
 * Live on save: runs `work` in one transaction together with a manifest bump for every screen
 * that showed `ref` before the change or shows it after, then notifies them once committed.
 * Two manifest fetches with the same version therefore always return the same content.
 */
export async function changeContent<T>(companyId: string, ref: ContentRef, work: (tx: Tx) => Promise<T>): Promise<T> {
  let bumped: BumpedScreen[] = [];
  const result = await withTransaction(async (tx) => {
    const before = await affectedScreens(companyId, ref, tx);
    const out = await work(tx);
    const after = await affectedScreens(companyId, ref, tx);
    bumped = await bumpManifests([...new Set([...before, ...after])], tx);
    return out;
  });
  emitManifestChanged(companyId, bumped);
  return result;
}
