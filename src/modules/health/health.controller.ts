import type { Request, Response } from "express";
import { APP_VERSION } from "../../config/constants.js";
import { checkDatabase } from "../../core/db/prisma.js";
import { checkRedis } from "../../core/redis/client.js";

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const healthy = db === "up" && redis === "up";
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", db, redis, version: APP_VERSION, time: new Date().toISOString() });
}
