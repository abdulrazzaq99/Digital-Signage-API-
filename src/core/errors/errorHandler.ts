import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { logger } from "../middleware/logger.js";
import { AppError, ConflictError, NotFoundError, RateLimitError, ValidationError } from "./AppError.js";

/** Unique-constraint columns reported as field errors (tenant columns are implied, not user input). */
function duplicateDetails(target: unknown) {
  const fields = (Array.isArray(target) ? target : typeof target === "string" ? [target] : []).filter((f): f is string => typeof f === "string" && f !== "companyId");
  return fields.length ? fields.map((f) => ({ path: `body.${f}`, message: "Already in use" })) : undefined;
}

type BodyParserError = { type: string; status: number };
const isBodyParserError = (err: unknown): err is BodyParserError =>
  !!err && typeof err === "object" && typeof (err as BodyParserError).type === "string" && typeof (err as BodyParserError).status === "number";

function normalize(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new ValidationError("Validation failed", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return new ConflictError("That value is already in use", "DUPLICATE", duplicateDetails(err.meta?.target));
    if (err.code === "P2025") return new NotFoundError("Record");
    if (err.code === "P2003") return new ConflictError("A related record does not exist or is still in use", "FOREIGN_KEY");
    if (err.code === "P2000") return new ValidationError("A value is too long", undefined, "VALUE_TOO_LONG");
    if (err.code === "P2023") return new ValidationError("Invalid identifier", undefined, "INVALID_ID");
    if (err.code === "P2034") return new ConflictError("The record changed while saving. Please try again", "WRITE_CONFLICT");
  }
  if (isBodyParserError(err)) {
    if (err.type === "entity.parse.failed") return new ValidationError("Malformed JSON body", undefined, "MALFORMED_JSON");
    if (err.type === "entity.too.large") return new AppError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    if (err.type === "encoding.unsupported" || err.type === "charset.unsupported") return new AppError(415, "UNSUPPORTED_ENCODING", "Unsupported request encoding");
    if (err.status >= 400 && err.status < 500) return new AppError(err.status, "BAD_REQUEST", "The request could not be read");
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
