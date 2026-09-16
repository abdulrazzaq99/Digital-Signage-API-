import type { RequestHandler } from "express";
import { IDEMPOTENCY_HEADER } from "../../config/constants.js";
import { prisma } from "../db/prisma.js";
import { ValidationError } from "../errors/AppError.js";

/**
 * Requires an Idempotency-Key header (mobile doc section 4: "safe retries"). The first response
 * for a (key, user, route) is stored; a retry with the same key replays it instead of re-running.
 */
export function idempotency(): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = req.header(IDEMPOTENCY_HEADER);
      if (!key || key.length > 128) return next(new ValidationError("Idempotency-Key header is required", undefined, "IDEMPOTENCY_KEY_REQUIRED"));
      const userId = req.user?.id ?? "anonymous";
      const route = `${req.method} ${req.baseUrl}${req.path}`;
      const existing = await prisma.idempotencyKey.findUnique({ where: { key_userId: { key, userId } } });
      if (existing) {
        if (existing.route !== route) return next(new ValidationError("Idempotency-Key was already used for a different request", undefined, "IDEMPOTENCY_KEY_MISMATCH"));
        res.setHeader("Idempotent-Replayed", "true");
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode < 500) {
          void prisma.idempotencyKey.create({ data: { key, userId, route, responseStatus: res.statusCode, responseBody: body as object } }).catch(() => undefined);
        }
        return originalJson(body);
      }) as typeof res.json;
      next();
    } catch (err) {
      next(err);
    }
  };
}
