import type { z } from "zod";
import { prisma } from "../../core/db/prisma.js";
import { NotFoundError } from "../../core/errors/AppError.js";
import { Events } from "../../core/realtime/events.js";
import { emitToCompany } from "../../core/realtime/server.js";
import { touchPresence } from "../../core/redis/presence.js";
import { buildManifest } from "./manifest.js";
import type { diagnosticsBody, heartbeatBody, syncAckBody } from "./player.schemas.js";

export const playerService = {
  /** Desired state for one screen. Versioned so players can compare with their local state. */
  manifest: buildManifest,

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
    // A canvas member that has the current version downloaded is ready for the shared start.
    if (body.status !== "failed" && body.version >= screen.manifestVersion) await prisma.canvasMember.updateMany({ where: { screenId }, data: { ready: true } });
    if (body.status === "failed") await prisma.activityLog.create({ data: { companyId, action: "screen.sync.failed", resourceType: "screen", resourceId: screenId, status: "FAILED", summary: `Sync failed: ${body.error ?? "unknown error"}` } });
    emitToCompany(companyId, Events.syncAck, { screenId, version: body.version, syncState, at: new Date().toISOString() });
  },

  async diagnostics(screenId: string, body: z.infer<typeof diagnosticsBody>) {
    await prisma.playerHeartbeat.create({ data: { screenId, payload: JSON.parse(JSON.stringify({ kind: "diagnostic", ...body })) } });
  },
};
