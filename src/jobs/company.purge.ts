import { logger } from "../core/middleware/logger.js";
import { deletePrefix } from "../core/storage/s3.js";

/**
 * Removes a deleted company's files from storage. Every key the API writes for a company starts with
 * `<companyId>/` (uploads, their derived files, rendered templates). Failures are thrown so BullMQ
 * retries; storage left behind is only a cost, never visible to anyone.
 */
export async function companyPurge(data: { companyId: string }): Promise<{ deleted: number }> {
  const deleted = await deletePrefix(`${data.companyId}/`);
  logger.info({ companyId: data.companyId, deleted }, "deleted company storage purged");
  return { deleted };
}
