import type { Response } from "express";

/** Success envelope: `{ data, meta? }`. */
export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200): void {
  res.status(status).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T): void {
  ok(res, data, undefined, 201);
}

export function noContent(res: Response): void {
  res.status(204).end();
}
