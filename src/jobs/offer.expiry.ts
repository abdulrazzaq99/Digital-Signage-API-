import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";

/**
 * Moves published offers past their `endsAt` to EXPIRED. Customers already stop seeing them at
 * `endsAt`; this keeps the Super Admin's status column honest. Re-publishing needs a later end date.
 */
export async function offerExpirySweep(now = new Date()): Promise<{ expired: number }> {
  const { count } = await prisma.offer.updateMany({ where: { status: "PUBLISHED", endsAt: { lte: now } }, data: { status: "EXPIRED" } });
  if (count) logger.info({ expired: count }, "offer expiry sweep");
  return { expired: count };
}
