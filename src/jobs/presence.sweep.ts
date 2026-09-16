import { PRESENCE_TTL_SEC } from "../config/constants.js";
import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";
import { Events } from "../core/realtime/events.js";
import { emitToCompany } from "../core/realtime/server.js";
import { onlineSet } from "../core/redis/presence.js";

/** Marks screens OFFLINE when their presence key has expired. Runs on the worker every 30 s. */
export async function presenceSweep(): Promise<{ markedOffline: number }> {
  const candidates = await prisma.screen.findMany({ where: { status: "ONLINE", pairingStatus: "PAIRED" }, select: { id: true, companyId: true } });
  const online = await onlineSet(candidates.map((s) => s.id));
  const stale = candidates.filter((s) => !online.has(s.id));
  const cutoff = new Date(Date.now() - PRESENCE_TTL_SEC * 1000);
  let markedOffline = 0;
  for (const s of stale) {
    const updated = await prisma.screen.updateMany({ where: { id: s.id, status: "ONLINE", OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] }, data: { status: "OFFLINE" } });
    if (updated.count) {
      markedOffline++;
      emitToCompany(s.companyId, Events.presence, { screenId: s.id, status: "OFFLINE", at: new Date().toISOString() });
      await prisma.activityLog.create({ data: { companyId: s.companyId, action: "screen.offline", resourceType: "screen", resourceId: s.id, status: "FAILED", summary: "Screen went offline" } });
    }
  }
  if (markedOffline) logger.info({ markedOffline }, "presence sweep");
  return { markedOffline };
}
