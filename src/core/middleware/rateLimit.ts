import type { Request, RequestHandler } from "express";
import { RateLimitError } from "../errors/AppError.js";
import { redis } from "../redis/client.js";

interface RateLimitOptions {
  /** Bucket name; combined with the key so different routes do not share counters. */
  name: string;
  key?: (req: Request) => string;
  limit: number;
  windowSec: number;
}

/** Fixed-window limiter backed by Redis INCR/EXPIRE. Sets standard RateLimit headers. */
export function rateLimit({ name, key = (req) => req.ip ?? "unknown", limit, windowSec }: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    try {
      const bucket = `rl:${name}:${key(req)}`;
      const count = await redis.incr(bucket);
      if (count === 1) await redis.expire(bucket, windowSec);
      const ttl = await redis.ttl(bucket);
      res.setHeader("RateLimit-Limit", String(limit));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - count)));
      res.setHeader("RateLimit-Reset", String(Math.max(0, ttl)));
      if (count > limit) return next(new RateLimitError(Math.max(1, ttl)));
      next();
    } catch (err) {
      next(err);
    }
  };
}
