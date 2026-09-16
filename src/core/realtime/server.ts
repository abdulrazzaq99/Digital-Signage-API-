import type { Server as HttpServer } from "node:http";
import { logger } from "../middleware/logger.js";

/** Socket.IO bootstrap; implemented fully in the screens/player task. */
export function initRealtime(_server: HttpServer): void {
  logger.debug("Realtime not yet initialised");
}

export async function closeRealtime(): Promise<void> {}
