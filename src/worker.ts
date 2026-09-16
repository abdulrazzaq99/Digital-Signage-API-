import { env } from "./config/env.js";
import { disconnectDatabase } from "./core/db/prisma.js";
import { logger } from "./core/middleware/logger.js";
import { closeRedis } from "./core/redis/client.js";

/** BullMQ worker bootstrap; job processors are registered as modules are built. */
logger.info({ env: env.NODE_ENV }, "Worker starting");

async function shutdown(): Promise<void> {
  await Promise.allSettled([disconnectDatabase(), closeRedis()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
