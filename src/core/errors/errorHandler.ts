import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { logger } from "../middleware/logger.js";
import { AppError, ConflictError, NotFoundError, RateLimitError, ValidationError } from "./AppError.js";

function normalize(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new ValidationError("Validation failed", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return new ConflictError("A record with the same unique value already exists", "DUPLICATE", { target: err.meta?.target });
    if (err.code === "P2025") return new NotFoundError("Record");
    if (err.code === "P2003") return new ConflictError("Related record does not exist", "FOREIGN_KEY");
  }
  if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed") {
    return new ValidationError("Malformed JSON body", undefined, "MALFORMED_JSON");
  }
  if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.too.large") {
    return new ValidationError("Request body too large", undefined, "PAYLOAD_TOO_LARGE");
  }
  return null;
}

/** Final Express error middleware. Never leaks stacks; always includes the request ID. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const known = normalize(err);
  if (known) {
    if (known instanceof RateLimitError) res.setHeader("Retry-After", String((known.details as { retryAfterSec: number }).retryAfterSec));
    if (known.status >= 500) logger.error({ err, requestId: req.id }, known.message);
    res.status(known.status).json(known.toJSON(req.id));
    return;
  }
  logger.error({ err, requestId: req.id, url: req.originalUrl }, "Unhandled error");
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId: req.id } });
};
