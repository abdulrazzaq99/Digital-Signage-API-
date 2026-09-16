import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server, type Socket } from "socket.io";
import { env } from "../../config/env.js";
import { sha256, verifyAccess } from "../auth/tokens.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../middleware/logger.js";
import { createRedisConnection } from "../redis/client.js";
import { touchPresence } from "../redis/presence.js";
import { companyRoom, Events, platformRoom, screenRoom, type EventName } from "./events.js";

let io: Server | null = null;

function tokenFrom(socket: Socket): string | undefined {
  const auth = socket.handshake.auth as { token?: string } | undefined;
  const header = socket.handshake.headers.authorization;
  return auth?.token ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
}

/** Boots Socket.IO with the /player and /app namespaces and a Redis adapter for multi-instance fan-out. */
export function initRealtime(server: HttpServer): Server {
  io = new Server(server, { cors: { origin: env.CORS_ORIGINS, credentials: true }, path: "/socket.io" });
  const pub = createRedisConnection();
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));

  // ---- /player: authenticated by device credential, bound to one screen ----
  const player = io.of("/player");
  player.use(async (socket, next) => {
    try {
      const token = tokenFrom(socket);
      if (!token) return next(new Error("DEVICE_UNAUTHORIZED"));
      const screen = await prisma.screen.findUnique({ where: { deviceCredentialHash: sha256(token) }, select: { id: true, companyId: true, pairingStatus: true } });
      if (!screen || screen.pairingStatus !== "PAIRED") return next(new Error("DEVICE_UNAUTHORIZED"));
      socket.data.screenId = screen.id;
      socket.data.companyId = screen.companyId;
      next();
    } catch (err) {
      next(err as Error);
    }
  });
  player.on("connection", async (socket) => {
    const { screenId, companyId } = socket.data as { screenId: string; companyId: string };
    await socket.join(screenRoom(screenId));
    await markOnline(screenId, companyId);
    socket.on(Events.presence, () => void markOnline(screenId, companyId));
    socket.on(Events.syncAck, (payload: { version?: number }) => void handleSyncAck(screenId, companyId, payload));
    socket.on("disconnect", () => logger.debug({ screenId }, "player disconnected"));
  });

  // ---- /app: authenticated by user JWT, joins the company room ----
  const app = io.of("/app");
  app.use((socket, next) => {
    try {
      const token = tokenFrom(socket);
      if (!token) return next(new Error("UNAUTHORIZED"));
      const claims = verifyAccess(token);
      socket.data.userId = claims.sub;
      socket.data.companyId = claims.companyId;
      socket.data.platform = claims.platformRole === "SUPER_ADMIN";
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });
  app.on("connection", async (socket) => {
    const { companyId, platform } = socket.data as { companyId: string | null; platform: boolean };
    if (platform) await socket.join(platformRoom);
    if (companyId) await socket.join(companyRoom(companyId));
  });

  logger.info("Realtime initialised (/player, /app)");
  return io;
}

async function markOnline(screenId: string, companyId: string): Promise<void> {
  const wasOnline = await touchPresence(screenId);
  if (!wasOnline) {
    await prisma.screen.update({ where: { id: screenId }, data: { status: "ONLINE", lastSeenAt: new Date() } }).catch(() => undefined);
    emitToCompany(companyId, Events.presence, { screenId, status: "ONLINE", at: new Date().toISOString() });
  } else {
    await prisma.screen.update({ where: { id: screenId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
}

async function handleSyncAck(screenId: string, companyId: string, payload: { version?: number }): Promise<void> {
  const version = Number(payload?.version ?? 0);
  const screen = await prisma.screen.findUnique({ where: { id: screenId }, select: { manifestVersion: true } });
  if (!screen) return;
  const synced = version >= screen.manifestVersion;
  await prisma.screen.update({ where: { id: screenId }, data: { ackVersion: version, syncState: synced ? "SYNCED" : "PENDING" } });
  emitToCompany(companyId, Events.syncAck, { screenId, version, syncState: synced ? "SYNCED" : "PENDING" });
}

export function emitToScreen(screenId: string, event: EventName, payload: unknown): void {
  io?.of("/player").to(screenRoom(screenId)).emit(event, payload);
}

export function emitToCompany(companyId: string, event: EventName, payload: unknown): void {
  io?.of("/app").to(companyRoom(companyId)).to(platformRoom).emit(event, payload);
}

export function emitToPlatform(event: EventName, payload: unknown): void {
  io?.of("/app").to(platformRoom).emit(event, payload);
}

export function getIo(): Server | null {
  return io;
}

export async function closeRealtime(): Promise<void> {
  await new Promise<void>((resolve) => (io ? io.close(() => resolve()) : resolve()));
  io = null;
}
