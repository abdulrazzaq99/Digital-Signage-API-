import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

const offer = (overrides: Record<string, unknown> = {}) => ({
  title: "Display Upgrade",
  category: "Hardware",
  summary: "Trade in your screens for 4K displays.",
  description: "Trade in your existing screens and upgrade to 4K commercial displays.",
  instructions: "Contact your account manager.",
  contact: { name: "Sam Lee", email: "Sam@Example.com", phone: "+44 20 7946 0000" },
  included: ["4K UHD", "3-year warranty"],
  steps: ["Request a quote.", "Confirm the order."],
  ...overrides,
});

describe("offer validation", () => {
  it("normalises contact details and keeps the lists when a PATCH leaves them out", async () => {
    const admin = await superAdminContext();
    const created = await api().post("/api/v1/offers").set(admin.auth).send(offer());
    expect(created.status).toBe(201);
    expect(created.body.data.contact).toMatchObject({ email: "sam@example.com", phone: "+442079460000" });

    const patched = await api().patch(`/api/v1/offers/${created.body.data.id}`).set(admin.auth).send({ title: "Display Upgrade 2026" });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ title: "Display Upgrade 2026", included: ["4K UHD", "3-year warranty"], steps: ["Request a quote.", "Confirm the order."] });
  });

  it("rejects unknown categories, oversized lists, bad contacts and unknown keys", async () => {
    const admin = await superAdminContext();
    const cases: [Record<string, unknown>, string][] = [
      [offer({ category: "Snacks" }), "body.category"],
      [offer({ included: Array.from({ length: 51 }, (_, i) => `Item ${i}`) }), "body.included"],
      [offer({ steps: ["x".repeat(201)] }), "body.steps.0"],
      [offer({ contact: { name: "Sam", email: "not-an-email" } }), "body.contact.email"],
      [offer({ contact: { name: "Sam", phone: "call me" } }), "body.contact.phone"],
      [offer({ featured: true }), "body"],
    ];
    for (const [body, path] of cases) {
      const res = await api().post("/api/v1/offers").set(admin.auth).send(body);
      expect(res.status, path).toBe(400);
      expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    }
  });

  it("requires the end to follow the start, including against the stored dates on PATCH", async () => {
    const admin = await superAdminContext();
    const bad = await api().post("/api/v1/offers").set(admin.auth).send(offer({ startsAt: "2030-06-02T00:00:00Z", endsAt: "2030-06-01T00:00:00Z" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ path: "body.endsAt", message: "Must be after the start" }]);

    const created = (await api().post("/api/v1/offers").set(admin.auth).send(offer({ startsAt: "2030-06-01T00:00:00Z" }))).body.data;
    const early = await api().patch(`/api/v1/offers/${created.id}`).set(admin.auth).send({ endsAt: "2030-05-01T00:00:00Z" });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe("INVALID_WINDOW");
    const ok = await api().patch(`/api/v1/offers/${created.id}`).set(admin.auth).send({ endsAt: "2030-07-01T00:00:00Z" });
    expect(ok.status).toBe(200);
  });

  it("rejects a malformed offer id before it reaches the database", async () => {
    const admin = await superAdminContext();
    const res = await api().get("/api/v1/offers/not-an-id").set(admin.auth);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ path: "params.id", message: "Invalid id" }]);
  });
});
