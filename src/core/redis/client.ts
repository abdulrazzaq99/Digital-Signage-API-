import { Redis } from "ioredis";
import { env } from "../../config/env.js";
import { logger } from "../middleware/logger.js";

export const redis = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2, enableOfflineQueue: true });
redis.on("error", (err) => logger.error({ err }, "Redis error"));

export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export async function checkRedis(): Promise<"up" | "down"> {
  try {
    return (await redis.ping()) === "PONG" ? "up" : "down";
  } catch {
    return "down";
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => undefined);
}
