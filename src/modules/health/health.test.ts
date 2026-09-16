import { afterAll, describe, expect, it } from "vitest";
import { api, closeAll } from "../../test/helpers.js";

afterAll(closeAll);

describe("GET /health", () => {
  it("reports db and redis up", async () => {
    const res = await api().get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "up", redis: "up" });
    expect(res.headers["x-request-id"]).toBeTypeOf("string");
  });

  it("returns ROUTE_NOT_FOUND envelope for unknown routes", async () => {
    const res = await api().get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });
});
