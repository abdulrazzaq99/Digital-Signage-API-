import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { disconnectDatabase } from "./core/db/prisma.js";
import { logger } from "./core/middleware/logger.js";
import { closeRealtime, initRealtime } from "./core/realtime/server.js";
import { closeRedis } from "./core/redis/client.js";
import { installProcessHandlers } from "./core/process.js";
import { closeQueue } from "./core/queue/queues.js";

const app = createApp();
const server = createServer(app);
initRealtime(server);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "API listening");
});

installProcessHandlers("API", async () => {
  // io.close() disconnects sockets and closes the HTTP server; idle keep-alive sockets are dropped.
  await closeRealtime();
  server.closeIdleConnections();
  await Promise.allSettled([closeQueue(), disconnectDatabase(), closeRedis()]);
});
