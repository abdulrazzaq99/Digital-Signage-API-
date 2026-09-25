import type { RequestHandler } from "express";
import { IDEMPOTENCY_HEADER } from "../../config/constants.js";
import { sha256 } from "../auth/tokens.js";
import { prisma } from "../db/prisma.js";
import { ConflictError, ValidationError } from "../errors/AppError.js";
import { redis } from "../redis/client.js";
import { logger } from "./logger.js";

/** Longest a request may hold its key before another request with it may run. */
const IN_FLIGHT_MS = 60_000;

const lockKey = (userId: string, key: string) => `idem:lock:${userId}:${sha256(key)}`;

/**
 * Requires an Idempotency-Key header (mobile doc section 4: "safe retries").
 *
 * - Only successful (2xx) responses are stored and replayed. A 4xx says the request was wrong or not
 *   possible right now (validation, a conflict, a licence block); the client fixes it and retries
 *   with the same key, and the retry is judged afresh. 5xx are never stored either.
 * - While a request with a key is running, another with the same key gets 409
 *   IDEMPOTENCY_IN_PROGRESS instead of running a second time (a Redis lock, released once the
 *   response is stored). If Redis is unavailable the lock is skipped with a warning.
 */
export function idempotency(): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = req.header(IDEMPOTENCY_HEADER);
      if (!key || key.length > 128) return next(new ValidationError("Idempotency-Key header is required", undefined, "IDEMPOTENCY_KEY_REQUIRED"));
      const userId = req.user?.id ?? "anonymous";
      const route = `${req.method} ${req.baseUrl}${req.path}`;
      const replay = async () => {
        const existing = await prisma.idempotencyKey.findUnique({ where: { key_userId: { key, userId } } });
        if (!existing) return false;
        if (existing.route !== route) throw new ValidationError("Idempotency-Key was already used for a different request", undefined, "IDEMPOTENCY_KEY_MISMATCH");
        res.setHeader("Idempotent-Replayed", "true");
        res.status(existing.responseStatus).json(existing.responseBody);
        return true;
      };
      if (await replay()) return;

      const lock = lockKey(userId, key);
      let locked = false;
      try {
        locked = (await redis.set(lock, route, "PX", IN_FLIGHT_MS, "NX")) === "OK";
        if (!locked) return next(new ConflictError("A request with this Idempotency-Key is still being processed; retry shortly", "IDEMPOTENCY_IN_PROGRESS"));
      } catch (err) {
        logger.warn({ err }, "idempotency lock unavailable; continuing without it");
      }
      let saving: Promise<unknown> = Promise.resolve();
      let released = false;
      const release = () => {
        if (released || !locked) return;
        released = true;
        // Hold the key until the stored response is visible, so a retry replays it rather than re-running.
        void saving.finally(() => redis.del(lock).catch(() => undefined));
      };
      // The previous holder may have finished between our first read and taking the lock.
      try {
        if (await replay()) return release();
      } catch (err) {
        release();
        throw err;
      }

      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          saving = prisma.idempotencyKey.create({ data: { key, userId, route, responseStatus: res.statusCode, responseBody: body as object } }).catch(() => undefined);
        }
        return originalJson(body);
      }) as typeof res.json;
      res.on("finish", release);
      res.on("close", release);
      next();
    } catch (err) {
      next(err);
    }
  };
}
