import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { offerExpirySweep } from "../../jobs/offer.expiry.js";
import { superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

const offerBody = { title: "Bundle deal", category: "Hardware", summary: "Two screens for one price", description: "Buy one display and get one free", instructions: "Call us", contact: { name: "Sales" } };
const hour = 3600_000;

describe("offer status transitions", () => {
  it("publishes a draft once, unpublishes only a live offer, and never publishes an ended one", async () => {
    const admin = await superAdminContext();
    const offer = (await api().post("/api/v1/offers").set(admin.auth).send(offerBody)).body.data;
    expect((await api().post(`/api/v1/offers/${offer.id}/unpublish`).set(admin.auth)).body.error.code).toBe("INVALID_STATUS_TRANSITION");
    expect((await api().post(`/api/v1/offers/${offer.id}/publish`).set(admin.auth)).body.data.status).toBe("PUBLISHED");
    const twice = await api().post(`/api/v1/offers/${offer.id}/publish`).set(admin.auth);
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatchObject({ code: "INVALID_STATUS_TRANSITION", details: { from: "PUBLISHED", to: "PUBLISHED" } });
    expect((await api().post(`/api/v1/offers/${offer.id}/unpublish`).set(admin.auth)).body.data.status).toBe("UNPUBLISHED");
    expect((await api().post(`/api/v1/offers/${offer.id}/unpublish`).set(admin.auth)).status).toBe(409);

    await api().patch(`/api/v1/offers/${offer.id}`).set(admin.auth).send({ endsAt: new Date(Date.now() - hour).toISOString() });
    const ended = await api().post(`/api/v1/offers/${offer.id}/publish`).set(admin.auth);
    expect(ended.status).toBe(409);
    expect(ended.body.error.code).toBe("OFFER_ENDED");
    await api().patch(`/api/v1/offers/${offer.id}`).set(admin.auth).send({ endsAt: new Date(Date.now() + hour).toISOString() });
    expect((await api().post(`/api/v1/offers/${offer.id}/publish`).set(admin.auth)).status).toBe(200);
  });

  it("expires published offers once their end date passes", async () => {
    const past = await prisma.offer.create({ data: { ...offerBody, title: "Old", status: "PUBLISHED", endsAt: new Date(Date.now() - 1000) } });
    const live = await prisma.offer.create({ data: { ...offerBody, title: "Live", status: "PUBLISHED", endsAt: new Date(Date.now() + hour) } });
    const draft = await prisma.offer.create({ data: { ...offerBody, title: "Draft", endsAt: new Date(Date.now() - 1000) } });
    expect(await offerExpirySweep()).toEqual({ expired: 1 });
    const status = async (id: string) => (await prisma.offer.findUniqueOrThrow({ where: { id } })).status;
    expect([await status(past.id), await status(live.id), await status(draft.id)]).toEqual(["EXPIRED", "PUBLISHED", "DRAFT"]);
  });
});

describe("campaign rules while active", () => {
  const window = () => ({ startsAt: new Date(Date.now() - hour).toISOString(), endsAt: new Date(Date.now() + 24 * hour).toISOString() });

  it("refuses changing the window, attempts, odds or prizes of an active campaign", async () => {
    const admin = await superAdminContext();
    const c = (await api().post("/api/v1/campaigns").set(admin.auth).send({ title: "Summer", ...window(), activate: true, prizes: [{ name: "Mug", quantity: 2 }] })).body.data;
    const res = await api().patch(`/api/v1/campaigns/${c.id}`).set(admin.auth).send({ maxAttempts: 5, loseWeight: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "CAMPAIGN_ACTIVE", details: { fields: ["maxAttempts", "loseWeight"] } });
    expect((await api().patch(`/api/v1/campaigns/${c.id}`).set(admin.auth).send({ endsAt: new Date(Date.now() + 48 * hour).toISOString() })).body.error.code).toBe("CAMPAIGN_ACTIVE");
    expect((await api().post(`/api/v1/campaigns/${c.id}/prizes`).set(admin.auth).send({ name: "Hat", quantity: 1 })).body.error.code).toBe("CAMPAIGN_ACTIVE");
    expect((await api().delete(`/api/v1/campaigns/${c.id}/prizes/${c.prizes[0].id}`).set(admin.auth)).body.error.code).toBe("CAMPAIGN_ACTIVE");
    // Presentation fields and unchanged values are fine.
    expect((await api().patch(`/api/v1/campaigns/${c.id}`).set(admin.auth).send({ title: "Summer Draw", maxAttempts: c.maxAttempts })).status).toBe(200);

    await api().post(`/api/v1/campaigns/${c.id}/deactivate`).set(admin.auth);
    expect((await api().patch(`/api/v1/campaigns/${c.id}`).set(admin.auth).send({ maxAttempts: 5 })).body.data.maxAttempts).toBe(5);
  });

  it("filters the list by effective status before paginating", async () => {
    const admin = await superAdminContext();
    const make = (title: string, status: "DRAFT" | "ACTIVE", startsAt: number, endsAt: number) =>
      prisma.scratchCampaign.create({ data: { title, status, startsAt: new Date(Date.now() + startsAt), endsAt: new Date(Date.now() + endsAt), allocation: { loseWeight: 1, prizes: [] } } });
    await make("Draft", "DRAFT", -hour, hour);
    await make("Live 1", "ACTIVE", -hour, hour);
    await make("Live 2", "ACTIVE", -2 * hour, 2 * hour);
    await make("Soon", "ACTIVE", hour, 2 * hour);
    await make("Over", "ACTIVE", -2 * hour, -hour);
    const page = await api().get("/api/v1/campaigns?status=ACTIVE&pageSize=1").set(admin.auth);
    expect(page.body.meta).toMatchObject({ total: 2, totalPages: 2 });
    expect(page.body.data).toHaveLength(1);
    expect(page.body.data[0].status).toBe("ACTIVE");
    const count = async (status: string) => (await api().get(`/api/v1/campaigns?status=${status}`).set(admin.auth)).body.meta.total;
    expect([await count("DRAFT"), await count("SCHEDULED"), await count("ENDED"), await count("INACTIVE")]).toEqual([1, 1, 1, 0]);
  });
});
