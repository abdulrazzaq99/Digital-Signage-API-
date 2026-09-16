import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { disconnectDatabase } from "./core/db/prisma.js";
import { logger } from "./core/middleware/logger.js";
import { closeRealtime, initRealtime } from "./core/realtime/server.js";
import { closeRedis } from "./core/redis/client.js";

const app = createApp();
const server = createServer(app);
initRealtime(server);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "API listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");
  server.close();
  await closeRealtime();
  await Promise.allSettled([disconnectDatabase(), closeRedis()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled rejection");
});
