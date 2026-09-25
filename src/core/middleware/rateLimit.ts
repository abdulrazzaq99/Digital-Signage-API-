import type { Request, RequestHandler } from "express";
import { RateLimitError } from "../errors/AppError.js";
import { redis } from "../redis/client.js";
import { logger } from "./logger.js";

interface RateLimitOptions {
  /** Bucket name; combined with the key so different routes do not share counters. */
  name: string;
  key?: (req: Request) => string;
  limit: number;
  windowSec: number;
}

/**
 * INCR and the window's expiry in one atomic step, so a crash between them can't leave a counter
 * that never expires (which would lock the key out for good). Returns [count, ttlMs].
 */
const INCR_WITH_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

/** Don't hold requests hostage to a Redis that isn't answering. */
const REDIS_TIMEOUT_MS = 1000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fixed-window limiter backed by Redis. Sets standard RateLimit headers. If Redis is down the
 * request is let through (fail open) with a warning: a limiter outage must not become an API outage.
 */
export function rateLimit({ name, key = (req) => req.ip ?? "unknown", limit, windowSec }: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    let count: number;
    let ttlSec: number;
    try {
      const bucket = `rl:${name}:${key(req)}`;
      const [c, ttlMs] = (await withTimeout(redis.eval(INCR_WITH_WINDOW, 1, bucket, String(windowSec * 1000)) as Promise<[number, number]>, REDIS_TIMEOUT_MS));
      count = c;
      ttlSec = Math.ceil(ttlMs / 1000);
    } catch (err) {
      logger.warn({ err, limiter: name }, "rate limiter unavailable; allowing request");
      return next();
    }
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - count)));
    res.setHeader("RateLimit-Reset", String(Math.max(0, ttlSec)));
    if (count > limit) return next(new RateLimitError(Math.max(1, ttlSec)));
    next();
  };
}
