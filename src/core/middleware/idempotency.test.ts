import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { errorHandler } from "../errors/errorHandler.js";
import { redis } from "../redis/client.js";
import { closeAll, resetDatabase } from "../../test/helpers.js";
import { idempotency } from "./idempotency.js";
import { rateLimit } from "./rateLimit.js";
import { requestId } from "./requestId.js";
import { validate } from "./validate.js";

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(closeAll);

let runs = 0;
let gate: Promise<void> = Promise.resolve();
const app = express();
app.use(express.json());
app.use(requestId);
app.post("/things", idempotency(), validate({ body: z.object({ name: z.string().min(1) }) }), async (_req, res) => {
  runs++;
  await gate;
  res.status(201).json({ data: { run: runs } });
});
app.get("/limited", rateLimit({ name: "test", limit: 2, windowSec: 60 }), (_req, res) => {
  res.json({ ok: true });
});
app.use(errorHandler);

describe("idempotency", () => {
  beforeEach(() => {
    runs = 0;
    gate = Promise.resolve();
  });

  it("does not cache a validation error, so a corrected retry with the same key runs", async () => {
    const bad = await request(app).post("/things").set("Idempotency-Key", "k1").send({ name: "" });
    expect(bad.status).toBe(400);
    const good = await request(app).post("/things").set("Idempotency-Key", "k1").send({ name: "ok" });
    expect(good.status).toBe(201);
    expect(good.headers["idempotent-replayed"]).toBeUndefined();
    const replay = await request(app).post("/things").set("Idempotency-Key", "k1").send({ name: "ok" });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(good.body);
    expect(runs).toBe(1);
  });

  it("refuses a second request with the same key while the first is still running", async () => {
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const first = request(app).post("/things").set("Idempotency-Key", "k2").send({ name: "a" }).then((r) => r);
    await vi.waitFor(() => expect(runs).toBe(1));
    const second = await request(app).post("/things").set("Idempotency-Key", "k2").send({ name: "a" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    open();
    expect((await first).status).toBe(201);
    await vi.waitFor(async () => expect((await request(app).post("/things").set("Idempotency-Key", "k2").send({ name: "a" })).headers["idempotent-replayed"]).toBe("true"));
    expect(runs).toBe(1);
  });
});

describe("rate limit", () => {
  it("counts atomically and sets an expiry on the window", async () => {
    expect((await request(app).get("/limited")).status).toBe(200);
    expect((await request(app).get("/limited")).headers["ratelimit-remaining"]).toBe("0");
    const limited = await request(app).get("/limited");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const keys = await redis.keys("rl:test:*");
    expect(keys).toHaveLength(1);
    expect(await redis.pttl(keys[0]!)).toBeGreaterThan(0);
  });

  it("fails open when Redis is unavailable", async () => {
    vi.spyOn(redis, "eval").mockRejectedValue(new Error("connect ECONNREFUSED"));
    for (let i = 0; i < 4; i++) expect((await request(app).get("/limited")).status).toBe(200);
  });
});
