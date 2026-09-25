import type { RequestHandler } from "express";
import { z, type ZodType } from "zod";
import { ValidationError } from "../errors/AppError.js";

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

declare module "express-serve-static-core" {
  interface Request {
    validated: { body: unknown; query: unknown; params: unknown };
  }
}

/**
 * Validates body, query, and params with Zod. Parsed values land on `req.validated`.
 * Object bodies are strict: an unknown key (usually a typo or a stale client) is a 400, not
 * silently dropped. Query strings stay lenient so cache-busting parameters don't break requests.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  const parts: ValidationSchemas = { ...schemas, body: schemas.body instanceof z.ZodObject ? schemas.body.strict() : schemas.body };
  return (req, _res, next) => {
    const issues: { path: string; message: string }[] = [];
    const out: Record<string, unknown> = { body: req.body, query: req.query, params: req.params };
    for (const part of ["body", "query", "params"] as const) {
      const schema = parts[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) out[part] = result.data;
      else issues.push(...result.error.issues.map((i) => ({ path: `${part}.${i.path.join(".")}`.replace(/\.$/, ""), message: i.message })));
    }
    if (issues.length) return next(new ValidationError("Validation failed", issues));
    req.validated = out as { body: unknown; query: unknown; params: unknown };
    next();
  };
}

/** Typed accessor for validated input inside controllers. */
export function input<B = unknown, Q = unknown, P = unknown>(req: { validated: { body: unknown; query: unknown; params: unknown } }) {
  return req.validated as { body: B; query: Q; params: P };
}
