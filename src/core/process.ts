import { logger } from "./middleware/logger.js";

const FORCE_EXIT_MS = 10_000;

/**
 * Signal and crash handling shared by the API and the worker. SIGTERM/SIGINT shut down cleanly;
 * an uncaught exception leaves the process in an unknown state, so it is logged and the process
 * exits (Docker restarts it). Unhandled rejections are logged and the process keeps serving.
 * A shutdown that hangs is forced after 10 seconds.
 */
export function installProcessHandlers(name: string, close: () => Promise<void>): void {
  let stopping = false;
  const stop = async (reason: string, code: number) => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, `${name} shutting down`);
    setTimeout(() => {
      logger.error(`${name} shutdown timed out; forcing exit`);
      process.exit(code || 1);
    }, FORCE_EXIT_MS).unref();
    try {
      await close();
    } catch (err) {
      logger.error({ err }, `${name} shutdown failed`);
    }
    process.exit(code);
  };

  process.on("SIGTERM", () => void stop("SIGTERM", 0));
  process.on("SIGINT", () => void stop("SIGINT", 0));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, `${name} uncaught exception`);
    void stop("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    logger.error({ err }, `${name} unhandled rejection`);
  });
}
