import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

describe("activity filters", () => {
  it("accepts known filters and rejects unknown resource types, bad ids and reversed ranges", async () => {
    const admin = await superAdminContext();
    expect((await api().get("/api/v1/activity?resourceType=screen_group&action=screen&from=2026-01-01T00:00:00Z").set(admin.auth)).status).toBe(200);
    expect((await api().get("/api/v1/activity?resourceType=spaceship").set(admin.auth)).status).toBe(400);
    const reversed = await api().get("/api/v1/activity?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z").set(admin.auth);
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.details).toEqual([{ path: "query.to", message: "Must be after the start" }]);
    expect((await api().get("/api/v1/activity?page=100001").set(admin.auth)).status).toBe(400);
  });

  it("rejects a malformed company id from the Super Admin's header or query", async () => {
    const admin = await superAdminContext();
    const header = await api().get("/api/v1/activity").set(admin.auth).set("X-Company-Id", "'; drop table");
    expect(header.status).toBe(400);
    expect(header.body.error).toMatchObject({ code: "VALIDATION_ERROR", details: [{ path: "headers.x-company-id", message: "Invalid id" }] });
    const query = await api().get("/api/v1/activity?companyId=nope").set(admin.auth);
    expect(query.status).toBe(400);
    expect(query.body.error.details[0].path).toBe("query.companyId");
  });
});
