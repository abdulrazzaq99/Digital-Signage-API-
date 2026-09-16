import { env } from "./config/env.js";
import { disconnectDatabase } from "./core/db/prisma.js";
import { logger } from "./core/middleware/logger.js";
import { closeRedis } from "./core/redis/client.js";
import { PRESENCE_SWEEP_INTERVAL_MS } from "./config/constants.js";
import { presenceSweep } from "./jobs/presence.sweep.js";
import { Worker } from "bullmq";
import { createRedisConnection } from "./core/redis/client.js";
import { JobNames, QUEUE_NAME } from "./core/queue/queues.js";
import { mediaConvert } from "./jobs/media.convert.js";

/** BullMQ worker bootstrap; job processors are registered as modules are built. */
logger.info({ env: env.NODE_ENV }, "Worker starting");

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    switch (job.name) {
      case JobNames.mediaConvert:
        return mediaConvert(job.data as { assetId: string; companyId: string });
      default:
        logger.warn({ name: job.name }, "unknown job");
    }
  },
  { connection: createRedisConnection(), concurrency: 4 },
);
worker.on("failed", (job, err) => logger.error({ err, job: job?.name, id: job?.id }, "job failed"));
worker.on("completed", (job) => logger.debug({ job: job.name, id: job.id }, "job completed"));

const sweep = setInterval(() => void presenceSweep().catch((err) => logger.error({ err }, "presence sweep failed")), PRESENCE_SWEEP_INTERVAL_MS);

async function shutdown(): Promise<void> {
  clearInterval(sweep);
  await worker.close();
  await Promise.allSettled([disconnectDatabase(), closeRedis()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
