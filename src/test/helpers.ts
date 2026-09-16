import type { Express } from "express";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../core/db/prisma.js";
import { redis } from "../core/redis/client.js";

let app: Express | null = null;

export function getApp(): Express {
  if (!app) app = createApp();
  return app;
}

export const api = () => request(getApp());

/** Truncates every table (except migrations) so each test file starts clean. */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const names = tables.map((t) => `"${t.tablename}"`).join(", ");
  if (names) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
  await redis.flushdb();
}

export async function closeAll(): Promise<void> {
  await prisma.$disconnect();
  await redis.quit().catch(() => undefined);
}
