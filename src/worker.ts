import { env } from "./config/env.js";
import { disconnectDatabase } from "./core/db/prisma.js";
import { logger } from "./core/middleware/logger.js";
import { closeRedis } from "./core/redis/client.js";
import { PRESENCE_SWEEP_INTERVAL_MS } from "./config/constants.js";
import { presenceSweep } from "./jobs/presence.sweep.js";

/** BullMQ worker bootstrap; job processors are registered as modules are built. */
logger.info({ env: env.NODE_ENV }, "Worker starting");

const sweep = setInterval(() => void presenceSweep().catch((err) => logger.error({ err }, "presence sweep failed")), PRESENCE_SWEEP_INTERVAL_MS);

async function shutdown(): Promise<void> {
  clearInterval(sweep);
  await Promise.allSettled([disconnectDatabase(), closeRedis()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
