import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { env } from "../../config/env.js";
import { playerService } from "../../modules/player/player.service.js";
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

/** Player → server payloads. The same rules as POST /player/sync-ack, plus an upper bound on the version. */
export const socketSyncAck = z.object({
  version: z.number().int().min(0).max(2 ** 31),
  status: z.enum(["downloaded", "activated", "failed"]).default("activated"),
  error: z.string().max(500).optional(),
});
/** Presence pings carry nothing the server needs; anything but an object (or nothing) is malformed. */
export const socketPresence = z.looseObject({}).nullish();

type Ack = (response: unknown) => void;

/**
 * Wraps a socket event handler: validates the payload, never lets an error escape (an async throw in
 * a listener would be an unhandled rejection), and reports problems to the sender as
 * `socket.error` { event, code, message, issues? } plus the ack callback when one was given.
 */
function handle<T>(socket: Socket, event: string, schema: z.ZodType<T>, fn: (payload: T) => Promise<void>) {
  socket.on(event, async (...args: unknown[]) => {
    const ack = typeof args.at(-1) === "function" ? (args.pop() as Ack) : undefined;
    const parsed = schema.safeParse(args[0]);
    if (!parsed.success) {
      const error = { event, code: "INVALID_PAYLOAD", message: "Invalid payload", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
      logger.warn({ event, screenId: socket.data.screenId, userId: socket.data.userId, issues: error.issues }, "rejected socket payload");
      socket.emit(Events.socketError, error);
      ack?.({ ok: false, error });
      return;
    }
    try {
      await fn(parsed.data);
      ack?.({ ok: true });
    } catch (err) {
      logger.error({ err, event, screenId: socket.data.screenId, userId: socket.data.userId }, "socket handler failed");
      const error = { event, code: "INTERNAL_ERROR", message: "The event could not be processed" };
      socket.emit(Events.socketError, error);
      ack?.({ ok: false, error });
    }
  });
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
      logger.error({ err }, "player socket authentication failed");
      next(new Error("INTERNAL_ERROR"));
    }
  });
  player.on("connection", async (socket) => {
    const { screenId, companyId } = socket.data as { screenId: string; companyId: string };
    handle(socket, Events.presence, socketPresence, () => markOnline(screenId, companyId));
    // Same effect as POST /player/sync-ack, canvas readiness included.
    handle(socket, Events.syncAck, socketSyncAck, (payload) => playerService.syncAck(screenId, companyId, payload));
    socket.on("disconnect", () => logger.debug({ screenId }, "player disconnected"));
    try {
      await socket.join(screenRoom(screenId));
      await markOnline(screenId, companyId);
    } catch (err) {
      logger.error({ err, screenId }, "player connection setup failed");
    }
  });

  // ---- /app: authenticated by user JWT, joins the company room ----
  const app = io.of("/app");
  app.use(async (socket, next) => {
    try {
      const token = tokenFrom(socket);
      if (!token) return next(new Error("UNAUTHORIZED"));
      const claims = verifyAccess(token);
      // A deactivated user's token may not have expired yet; the database decides.
      const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { isActive: true, companyId: true, platformRole: true } });
      if (!user || !user.isActive) return next(new Error("ACCOUNT_DISABLED"));
      socket.data.userId = claims.sub;
      socket.data.companyId = user.companyId;
      socket.data.platform = user.platformRole === "SUPER_ADMIN";
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });
  app.on("connection", async (socket) => {
    const { companyId, platform } = socket.data as { companyId: string | null; platform: boolean };
    try {
      if (platform) await socket.join(platformRoom);
      if (companyId) await socket.join(companyRoom(companyId));
    } catch (err) {
      logger.error({ err, userId: socket.data.userId }, "app connection setup failed");
    }
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
