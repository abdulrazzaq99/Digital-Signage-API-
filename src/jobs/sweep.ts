import { randomUUID } from "node:crypto";
import { logger } from "../core/middleware/logger.js";
import { redis } from "../core/redis/client.js";

export interface Sweep {
  /** Runs once unless the previous run is still going or another worker holds the lock. Resolves whether it ran. */
  tick(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export const sweepLockKey = (name: string) => `sweep:lock:${name}`;

/**
 * A periodic job on the worker, safe with several workers running:
 * - a tick is skipped while this process's previous run is still going (no overlap);
 * - each run first takes a Redis lock (SET NX PX) that lives for most of the interval and is not
 *   released early, so across all workers the sweep runs at most once per interval.
 * Errors are logged, never thrown.
 */
export function createSweep(name: string, run: () => Promise<unknown>, intervalMs: number, lockMs = Math.max(1000, Math.floor(intervalMs * 0.9))): Sweep {
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<boolean> {
    if (running) {
      logger.warn({ sweep: name }, "previous sweep still running; skipping this tick");
      return false;
    }
    running = true;
    try {
      const acquired = await redis.set(sweepLockKey(name), randomUUID(), "PX", lockMs, "NX");
      if (acquired !== "OK") return false;
      await run();
      return true;
    } catch (err) {
      logger.error({ err, sweep: name }, "sweep failed");
      return false;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      timer ??= setInterval(() => void tick(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
