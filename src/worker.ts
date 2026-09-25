import { Worker } from "bullmq";
import { EXPIRY_SWEEP_INTERVAL_MS, MEDIA_CLEANUP_INTERVAL_MS, PRESENCE_SWEEP_INTERVAL_MS } from "./config/constants.js";
import { env } from "./config/env.js";
import { disconnectDatabase } from "./core/db/prisma.js";
import { logger } from "./core/middleware/logger.js";
import { installProcessHandlers } from "./core/process.js";
import { QUEUE_NAME } from "./core/queue/queues.js";
import { closeRedis, createRedisConnection } from "./core/redis/client.js";
import { licenseExpirySweep } from "./jobs/license.expiry.js";
import { mediaCleanup } from "./jobs/media.cleanup.js";
import { offerExpirySweep } from "./jobs/offer.expiry.js";
import { presenceSweep } from "./jobs/presence.sweep.js";
import { onJobFailed, processJob } from "./jobs/registry.js";
import { createSweep } from "./jobs/sweep.js";

/** BullMQ worker bootstrap: queued jobs (validated per job type) plus the periodic sweeps. */
logger.info({ env: env.NODE_ENV }, "Worker starting");

const worker = new Worker(QUEUE_NAME, (job) => processJob(job), { connection: createRedisConnection(), concurrency: 4 });
worker.on("failed", (job, err) => void onJobFailed(job, err));
// Connection and processor errors outside a job; without a listener they would be unhandled.
worker.on("error", (err) => logger.error({ err }, "worker error"));
worker.on("completed", (job) => logger.debug({ job: job.name, id: job.id }, "job completed"));

const sweeps = [
  createSweep("presence", presenceSweep, PRESENCE_SWEEP_INTERVAL_MS),
  createSweep("media-cleanup", mediaCleanup, MEDIA_CLEANUP_INTERVAL_MS),
  createSweep("licence-expiry", licenseExpirySweep, EXPIRY_SWEEP_INTERVAL_MS),
  createSweep("offer-expiry", offerExpirySweep, EXPIRY_SWEEP_INTERVAL_MS),
];
for (const s of sweeps) s.start();

installProcessHandlers("Worker", async () => {
  for (const s of sweeps) s.stop();
  await worker.close();
  await Promise.allSettled([disconnectDatabase(), closeRedis()]);
});
