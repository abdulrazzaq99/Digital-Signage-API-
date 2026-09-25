import { env } from "./config/env.js";
import { disconnectDatabase } from "./core/db/prisma.js";
import { logger } from "./core/middleware/logger.js";
import { closeRedis } from "./core/redis/client.js";
import { installProcessHandlers } from "./core/process.js";
import { EXPIRY_SWEEP_INTERVAL_MS, MEDIA_CLEANUP_INTERVAL_MS, PRESENCE_SWEEP_INTERVAL_MS } from "./config/constants.js";
import { licenseExpirySweep } from "./jobs/license.expiry.js";
import { offerExpirySweep } from "./jobs/offer.expiry.js";
import { presenceSweep } from "./jobs/presence.sweep.js";
import { mediaCleanup } from "./jobs/media.cleanup.js";
import { Worker } from "bullmq";
import { createRedisConnection } from "./core/redis/client.js";
import { JobNames, QUEUE_NAME } from "./core/queue/queues.js";
import { mediaConvert } from "./jobs/media.convert.js";
import { templateRender } from "./jobs/template.render.js";
import { notificationSend } from "./jobs/notification.send.js";
import { mailSend } from "./jobs/mail.send.js";
import { companyPurge } from "./jobs/company.purge.js";
import type { MailMessage } from "./core/mail/MailProvider.js";

/** BullMQ worker bootstrap; job processors are registered as modules are built. */
logger.info({ env: env.NODE_ENV }, "Worker starting");

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    switch (job.name) {
      case JobNames.mediaConvert:
        return mediaConvert(job.data as { assetId: string; companyId: string });
      case JobNames.templateRender:
        return templateRender(job.data as { instanceId: string; companyId: string });
      case JobNames.notificationSend:
        return notificationSend(job.data as { notificationId: string });
      case JobNames.mailSend:
        return mailSend(job.data as MailMessage);
      case JobNames.companyPurge:
        return companyPurge(job.data as { companyId: string });
      default:
        // Fail it (visible in the failed set) rather than completing a job nothing processed.
        throw new Error(`Unknown job: ${job.name}`);
    }
  },
  { connection: createRedisConnection(), concurrency: 4 },
);
worker.on("failed", (job, err) => logger.error({ err, job: job?.name, id: job?.id, attempt: job?.attemptsMade }, "job failed"));
// Connection and processor errors outside a job; without a listener they would be unhandled.
worker.on("error", (err) => logger.error({ err }, "worker error"));
worker.on("completed", (job) => logger.debug({ job: job.name, id: job.id }, "job completed"));

const sweep = setInterval(() => void presenceSweep().catch((err) => logger.error({ err }, "presence sweep failed")), PRESENCE_SWEEP_INTERVAL_MS);
const cleanup = setInterval(() => void mediaCleanup().catch((err) => logger.error({ err }, "media cleanup failed")), MEDIA_CLEANUP_INTERVAL_MS);
const expiry = setInterval(() => {
  void licenseExpirySweep().catch((err) => logger.error({ err }, "licence expiry sweep failed"));
  void offerExpirySweep().catch((err) => logger.error({ err }, "offer expiry sweep failed"));
}, EXPIRY_SWEEP_INTERVAL_MS);

installProcessHandlers("Worker", async () => {
  clearInterval(sweep);
  clearInterval(cleanup);
  clearInterval(expiry);
  await worker.close();
  await Promise.allSettled([disconnectDatabase(), closeRedis()]);
});
