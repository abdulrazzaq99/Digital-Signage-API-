import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { notificationSend } from "../../jobs/notification.send.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

type Ctx = Awaited<ReturnType<typeof customerContext>>;
type Admin = Awaited<ReturnType<typeof superAdminContext>>;

async function category(admin: Admin, name: string) {
  const res = await api().post("/api/v1/categories").set(admin.auth).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; name: string };
}

/** A Super Admin, the Kiosk and Restaurant categories, two kiosks and one restaurant. */
async function world() {
  const admin = await superAdminContext();
  const kiosk = await category(admin, "Kiosk");
  const restaurant = await category(admin, "Restaurant");
  const inCategory = async (categoryId: string) => {
    const ctx = await customerContext();
    expect((await api().patch(`/api/v1/companies/${ctx.company.id}`).set(admin.auth).send({ categoryId })).status).toBe(200);
    return ctx;
  };
  return { admin, kiosk, restaurant, kioskA: await inCategory(kiosk.id), kioskB: await inCategory(kiosk.id), bar: await inCategory(restaurant.id) };
}

const offer = (title: string, audience?: unknown) => ({
  title, category: "Hardware", summary: "A summary that is long enough.", description: "A description that is long enough.", instructions: "Call us.", contact: { name: "Sam Lee" }, ...(audience ? { audience } : {}),
});

async function publishedOffer(admin: Admin, title: string, audience?: unknown) {
  const o = await api().post("/api/v1/offers").set(admin.auth).send(offer(title, audience));
  expect(o.status).toBe(201);
  expect((await api().post(`/api/v1/offers/${o.body.data.id}/publish`).set(admin.auth)).status).toBe(200);
  return o.body.data as { id: string; audience: unknown };
}

const titles = async (ctx: Ctx, path: string) => ((await api().get(path).set(ctx.auth)).body.data as { title?: string; name?: string }[]).map((x) => x.title ?? x.name).sort();

describe("location categories", () => {
  it("lets the Super Admin add, rename and delete categories, and refuses duplicates or ones in use", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const kiosk = await category(admin, "Kiosk");
    const dup = await api().post("/api/v1/categories").set(admin.auth).send({ name: " kiosk " });
    expect(dup.status).toBe(409);
    expect((await api().post("/api/v1/categories").set(ctx.auth).send({ name: "Bar" })).status).toBe(403);

    expect((await api().patch(`/api/v1/categories/${kiosk.id}`).set(admin.auth).send({ name: "Kiosks" })).body.data.name).toBe("Kiosks");
    await api().patch(`/api/v1/companies/${ctx.company.id}`).set(admin.auth).send({ categoryId: kiosk.id });
    const listed = await api().get("/api/v1/categories").set(ctx.auth);
    expect(listed.body.data).toEqual([expect.objectContaining({ name: "Kiosks", companies: 1 })]);

    const inUse = await api().delete(`/api/v1/categories/${kiosk.id}`).set(admin.auth);
    expect([inUse.status, inUse.body.error.code]).toEqual([409, "CATEGORY_IN_USE"]);
    await api().patch(`/api/v1/companies/${ctx.company.id}`).set(admin.auth).send({ categoryId: null });
    await api().post("/api/v1/offers").set(admin.auth).send(offer("Kiosk deal", { kind: "categories", categoryIds: [kiosk.id] }));
    const byOffer = await api().delete(`/api/v1/categories/${kiosk.id}`).set(admin.auth);
    expect(byOffer.body.error.message).toContain("1 offer");
    await prisma.offer.deleteMany();
    expect((await api().delete(`/api/v1/categories/${kiosk.id}`).set(admin.auth)).status).toBe(204);
  });

  it("sets a location's category; only the Super Admin can change it", async () => {
    const admin = await superAdminContext();
    const kiosk = await category(admin, "Kiosk");
    const created = await api().post("/api/v1/companies").set(admin.auth).send({ name: "Bar 1", screenLimit: 2, categoryId: kiosk.id });
    expect(created.body.data.category).toEqual({ id: kiosk.id, name: "Kiosk" });
    const unknown = await api().post("/api/v1/companies").set(admin.auth).send({ name: "Bar 2", screenLimit: 2, categoryId: "cmissing0000000000000000a" });
    expect([unknown.status, unknown.body.error.code]).toEqual([400, "CATEGORY_NOT_FOUND"]);

    const ctx = await customerContext();
    expect((await api().patch(`/api/v1/companies/${ctx.company.id}`).set(ctx.auth).send({ categoryId: kiosk.id })).status).toBe(403);
    const filtered = await api().get(`/api/v1/companies?categoryId=${kiosk.id}`).set(admin.auth);
    expect(filtered.body.data.map((c: { name: string }) => c.name)).toEqual(["Bar 1"]);
    const none = await api().get("/api/v1/companies?categoryId=none").set(admin.auth);
    expect(none.body.data.map((c: { id: string }) => c.id)).toEqual([ctx.company.id]);
  });
});

describe("content aimed at locations", () => {
  it("shows Marketplace offers only to the locations they are for", async () => {
    const w = await world();
    await publishedOffer(w.admin, "For everyone");
    const forRestaurants = await publishedOffer(w.admin, "For restaurants", { kind: "categories", categoryIds: [w.restaurant.id] });
    await publishedOffer(w.admin, "For both", { kind: "categories", categoryIds: [w.kiosk.id, w.restaurant.id] });
    await publishedOffer(w.admin, "For kiosk B", { kind: "companies", companyIds: [w.kioskB.company.id] });

    expect(await titles(w.kioskA, "/api/v1/offers")).toEqual(["For both", "For everyone"]);
    expect(await titles(w.kioskB, "/api/v1/offers")).toEqual(["For both", "For everyone", "For kiosk B"]);
    expect(await titles(w.bar, "/api/v1/offers")).toEqual(["For both", "For everyone", "For restaurants"]);
    expect((await api().get(`/api/v1/offers/${forRestaurants.id}`).set(w.kioskA.auth)).status).toBe(404);
    expect((await api().post(`/api/v1/offers/${forRestaurants.id}/views`).set(w.kioskA.auth)).status).toBe(404);

    // The Super Admin sees who each offer is for; locations don't.
    expect(forRestaurants.audience).toEqual({ kind: "categories", categoryIds: [w.restaurant.id] });
    expect((await api().get(`/api/v1/offers/${forRestaurants.id}`).set(w.bar.auth)).body.data.audience).toBeUndefined();
    const bad = await api().post("/api/v1/offers").set(w.admin.auth).send(offer("Typo", { kind: "categories", categoryIds: ["cmissing0000000000000000a"] }));
    expect([bad.status, bad.body.error.code]).toEqual([400, "AUDIENCE_NOT_FOUND"]);
  });

  it("lets only the chosen locations use a template", async () => {
    const w = await world();
    const t = await api().post("/api/v1/templates").set(w.admin.auth).send({ name: "Extra Gum", category: "Promotion", fields: [{ key: "price", label: "Price", type: "text", required: true }], audience: { kind: "categories", categoryIds: [w.restaurant.id] } });
    expect(t.status).toBe(201);
    expect(await titles(w.bar, "/api/v1/templates")).toEqual(["Extra Gum"]);
    expect(await titles(w.kioskA, "/api/v1/templates")).toEqual([]);
    const blocked = await api().post("/api/v1/template-instances").set(w.kioskA.auth).send({ templateId: t.body.data.id, name: "Gum", values: { price: "10 kr" } });
    expect([blocked.status, blocked.body.error.code]).toEqual([400, "TEMPLATE_NOT_FOUND"]);
    expect((await api().post("/api/v1/template-instances").set(w.bar.auth).send({ templateId: t.body.data.id, name: "Gum", values: { price: "10 kr" } })).status).toBe(201);

    const widened = await api().patch(`/api/v1/templates/${t.body.data.id}`).set(w.admin.auth).send({ audience: { kind: "all" } });
    expect(widened.body.data.audience).toEqual({ kind: "all" });
    expect(await titles(w.kioskA, "/api/v1/templates")).toEqual(["Extra Gum"]);
    expect((await api().patch(`/api/v1/templates/${t.body.data.id}`).set(w.bar.auth).send({ audience: { kind: "all" } })).status).toBe(403);
  });

  it("lets only the chosen locations play a Scratch & Win campaign", async () => {
    const w = await world();
    const res = await api().post("/api/v1/campaigns").set(w.admin.auth).send({ title: "Restaurant Draw", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), loseWeight: 0, activate: true, prizes: [{ name: "Gum", quantity: 5 }], audience: { kind: "companies", companyIds: [w.bar.company.id] } });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    expect(await titles(w.bar, "/api/v1/campaigns")).toEqual(["Restaurant Draw"]);
    expect(await titles(w.kioskA, "/api/v1/campaigns")).toEqual([]);
    expect((await api().get(`/api/v1/campaigns/${id}/eligibility`).set(w.kioskA.auth)).status).toBe(404);
    expect((await api().post(`/api/v1/campaigns/${id}/attempts`).set(w.kioskA.auth).set("Idempotency-Key", "k1")).status).toBe(404);
    expect((await api().post(`/api/v1/campaigns/${id}/attempts`).set(w.bar.auth).set("Idempotency-Key", "b1")).status).toBe(200);
  });

  it("delivers a notification to the locations in a category", async () => {
    const w = await world();
    const n = await api().post("/api/v1/notifications").set(w.admin.auth).send({ title: "New menu", body: "Restaurants: the new menu is out.", audience: { kind: "categories", categoryIds: [w.restaurant.id] } });
    expect(n.status).toBe(202);
    await notificationSend({ notificationId: n.body.data.id });
    expect(await titles(w.bar, "/api/v1/notifications/inbox")).toEqual(["New menu"]);
    expect(await titles(w.kioskA, "/api/v1/notifications/inbox")).toEqual([]);
  });
});
