import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";

/**
 * Marks licences whose `expiresAt` has passed as EXPIRED, with an activity entry per company. The
 * API already treats a past `expiresAt` as expired; this makes the stored state and the Super
 * Admin's licence list agree. Suspended or disabled licences keep their state.
 */
export async function licenseExpirySweep(now = new Date()): Promise<{ expired: number }> {
  const due = await prisma.license.findMany({ where: { state: "ACTIVE", expiresAt: { lte: now } }, select: { id: true, companyId: true, expiresAt: true } });
  let expired = 0;
  for (const l of due) {
    // Re-checked in the update, so a licence renewed in the meantime stays active.
    const { count } = await prisma.license.updateMany({ where: { id: l.id, state: "ACTIVE", expiresAt: { lte: now } }, data: { state: "EXPIRED" } });
    if (!count) continue;
    expired++;
    await prisma.activityLog.create({ data: { companyId: l.companyId, action: "license.expired", resourceType: "license", resourceId: l.id, status: "PENDING", summary: `Licence expired on ${l.expiresAt!.toISOString().slice(0, 10)}; the account is read-only until it is renewed` } });
  }
  if (expired) logger.info({ expired }, "licence expiry sweep");
  return { expired };
}
