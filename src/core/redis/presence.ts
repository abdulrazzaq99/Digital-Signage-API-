import { PRESENCE_TTL_SEC } from "../../config/constants.js";
import { redis } from "./client.js";

const key = (screenId: string) => `presence:screen:${screenId}`;

/** Refreshes the presence key. Returns whether the screen was already online. */
export async function touchPresence(screenId: string): Promise<boolean> {
  const result = await redis.set(key(screenId), String(Date.now()), "EX", PRESENCE_TTL_SEC, "GET");
  return result !== null;
}

export async function isOnline(screenId: string): Promise<boolean> {
  return (await redis.exists(key(screenId))) === 1;
}

export async function clearPresence(screenId: string): Promise<void> {
  await redis.del(key(screenId));
}

export async function onlineSet(screenIds: string[]): Promise<Set<string>> {
  if (screenIds.length === 0) return new Set();
  const results = await redis.mget(...screenIds.map(key));
  return new Set(screenIds.filter((_, i) => results[i] !== null));
}
