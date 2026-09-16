import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler } from "../errors/errorHandler.js";
import { requestId } from "./requestId.js";
import { input, validate } from "./validate.js";

const app = express();
app.use(express.json());
app.use(requestId);
app.post("/items/:id", validate({ params: z.object({ id: z.string().min(2) }), body: z.object({ name: z.string().min(1), qty: z.coerce.number().int().positive() }) }), (req, res) => {
  const { body, params } = input<{ name: string; qty: number }, unknown, { id: string }>(req);
  res.json({ ok: true, id: params.id, qty: body.qty });
});
app.use(errorHandler);

describe("validate middleware", () => {
  it("returns 400 with field details on invalid input", async () => {
    const res = await request(app).post("/items/x").send({ name: "", qty: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["params.id", "body.name", "body.qty"]));
    expect(res.body.error.requestId).toBeTypeOf("string");
  });

  it("passes parsed values to the handler", async () => {
    const res = await request(app).post("/items/ab").send({ name: "Lobby", qty: "3" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: "ab", qty: 3 });
  });

  it("maps malformed JSON to MALFORMED_JSON", async () => {
    const res = await request(app).post("/items/ab").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MALFORMED_JSON");
  });
});
