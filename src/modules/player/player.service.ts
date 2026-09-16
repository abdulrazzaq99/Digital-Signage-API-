import type { z } from "zod";
import { prisma } from "../../core/db/prisma.js";
import { NotFoundError } from "../../core/errors/AppError.js";
import { Events } from "../../core/realtime/events.js";
import { emitToCompany } from "../../core/realtime/server.js";
import { touchPresence } from "../../core/redis/presence.js";
import { presignGet } from "../../core/storage/s3.js";
import type { diagnosticsBody, heartbeatBody, syncAckBody } from "./player.schemas.js";

export const playerService = {
  /** Desired state for one screen. Versioned so players can compare with their local state. */
  async manifest(screenId: string) {
    const screen = await prisma.screen.findUnique({ where: { id: screenId }, include: { assignment: true, canvasMember: { include: { set: { include: { members: true } } } } } });
    if (!screen) throw new NotFoundError("Screen");
    const groupIds = (await prisma.screenGroupMember.findMany({ where: { screenId }, select: { groupId: true } })).map((g) => g.groupId);
    const schedules = await prisma.schedule.findMany({
      where: { AND: [{ OR: [{ targetKind: "SCREEN", targetId: screenId }, { targetKind: "GROUP", targetId: { in: groupIds } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: new Date(Date.now() - 24 * 3600_000) } }] }] },
      orderBy: { startsAt: "asc" },
    });

    let assignment: { kind: string; refId: string; name: string } | null = null;
    let assets: { id: string; type: string; url: string; checksum: string | null; sizeBytes: number; durationSec: number; mimeType: string; position: number }[] = [];
    let layout: { presetId: string; zones: { index: number; name: string; x: number; y: number; w: number; h: number; bindingKind: string | null; refId: string | null }[] } | null = null;

    if (screen.assignment) {
      const a = screen.assignment;
      if (a.kind === "PLAYLIST") {
        const playlist = await prisma.playlist.findUnique({ where: { id: a.refId }, include: { items: { include: { asset: true }, orderBy: { position: "asc" } } } });
        if (playlist) {
          assignment = { kind: "PLAYLIST", refId: playlist.id, name: playlist.name };
          assets = await Promise.all(playlist.items.map(async (it) => ({ id: it.asset.id, type: it.asset.type, url: await presignGet(it.asset.storageKey), checksum: it.asset.checksum, sizeBytes: Number(it.asset.sizeBytes), durationSec: it.durationSec, mimeType: it.asset.mimeType, position: it.position })));
        }
      } else if (a.kind === "LAYOUT") {
        const l = await prisma.layout.findUnique({ where: { id: a.refId }, include: { zones: { orderBy: { index: "asc" }, include: { asset: true, playlist: { include: { items: { include: { asset: true }, orderBy: { position: "asc" } } } } } } } });
        if (l) {
          assignment = { kind: "LAYOUT", refId: l.id, name: l.name };
          layout = { presetId: l.presetId, zones: l.zones.map((z) => ({ index: z.index, name: z.name, x: z.x, y: z.y, w: z.w, h: z.h, bindingKind: z.bindingKind, refId: z.assetId ?? z.playlistId })) };
          const seen = new Map<string, (typeof assets)[number]>();
          let pos = 0;
          for (const z of l.zones) {
            const items = z.asset ? [{ asset: z.asset, durationSec: 10 }] : (z.playlist?.items ?? []);
            for (const it of items) if (!seen.has(it.asset.id)) seen.set(it.asset.id, { id: it.asset.id, type: it.asset.type, url: await presignGet(it.asset.storageKey), checksum: it.asset.checksum, sizeBytes: Number(it.asset.sizeBytes), durationSec: it.durationSec, mimeType: it.asset.mimeType, position: pos++ });
          }
          assets = [...seen.values()];
        }
      } else if (a.kind === "TEMPLATE_INSTANCE") {
        const t = await prisma.templateInstance.findUnique({ where: { id: a.refId } });
        if (t) {
          assignment = { kind: "TEMPLATE_INSTANCE", refId: t.id, name: t.name };
          if (t.outputKey) assets = [{ id: t.id, type: "IMAGE", url: await presignGet(t.outputKey), checksum: null, sizeBytes: 0, durationSec: 15, mimeType: "image/png", position: 0 }];
        }
      }
    }

    const canvas = screen.canvasMember ? { setId: screen.canvasMember.setId, position: screen.canvasMember.position, total: screen.canvasMember.set.members.length, activateAt: screen.canvasMember.set.activateAt?.toISOString() ?? null } : null;

    return {
      version: screen.manifestVersion, screenId: screen.id, companyId: screen.companyId, orientation: screen.orientation, generatedAt: new Date().toISOString(), activateAt: screen.assignment?.activateAt?.toISOString() ?? null,
      assignment, assets, layout, canvas,
      schedule: schedules.map((s) => ({ id: s.id, playlistId: s.playlistId, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt?.toISOString() ?? null, timezone: s.timezone })),
    };
  },

  async heartbeat(screenId: string, companyId: string, body: z.infer<typeof heartbeatBody>) {
    const wasOnline = await touchPresence(screenId);
    const screen = await prisma.screen.update({
      where: { id: screenId },
      data: { status: body.state === "ERROR" ? "ERROR" : "ONLINE", lastSeenAt: new Date(), device: { update: { playerVersion: body.playerVersion, appVersion: body.appVersion, firmware: body.firmware, ip: body.ip, resolution: body.resolution, storageFree: body.storageFree !== undefined ? BigInt(body.storageFree) : undefined, storageTotal: body.storageTotal !== undefined ? BigInt(body.storageTotal) : undefined } } },
      select: { manifestVersion: true, status: true },
    });
    if (!wasOnline) emitToCompany(companyId, Events.presence, { screenId, status: screen.status, at: new Date().toISOString() });
    return { manifestVersion: screen.manifestVersion, serverTime: new Date().toISOString() };
  },

  async syncAck(screenId: string, companyId: string, body: z.infer<typeof syncAckBody>) {
    const screen = await prisma.screen.findUnique({ where: { id: screenId }, select: { manifestVersion: true } });
    if (!screen) throw new NotFoundError("Screen");
    const syncState = body.status === "failed" ? "FAILED" : body.status === "downloaded" ? "SYNCING" : body.version >= screen.manifestVersion ? "SYNCED" : "PENDING";
    await prisma.screen.update({ where: { id: screenId }, data: { ackVersion: body.status === "activated" ? body.version : undefined, syncState } });
    if (body.status === "failed") await prisma.activityLog.create({ data: { companyId, action: "screen.sync.failed", resourceType: "screen", resourceId: screenId, status: "FAILED", summary: `Sync failed: ${body.error ?? "unknown error"}` } });
    emitToCompany(companyId, Events.syncAck, { screenId, version: body.version, syncState, at: new Date().toISOString() });
  },

  async diagnostics(screenId: string, body: z.infer<typeof diagnosticsBody>) {
    await prisma.playerHeartbeat.create({ data: { screenId, payload: JSON.parse(JSON.stringify({ kind: "diagnostic", ...body })) } });
  },
};
