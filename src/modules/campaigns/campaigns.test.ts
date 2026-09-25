import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { createUser, customerContext, login, superAdminContext, tokenFor } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

const offerBody = { title: "Display Upgrade Programme", category: "Hardware", summary: "Trade in your screens for 4K displays at preferential pricing.", description: "Full description of the upgrade programme for account holders.", instructions: "Contact your account manager to request a quotation.", contact: { name: "James Whitfield", email: "j@example.com" } };

async function activeCampaign(admin: { auth: Record<string, string> }, overrides: Record<string, unknown> = {}) {
  const res = await api().post("/api/v1/campaigns").set(admin.auth).send({ title: "Summer Draw", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), maxAttempts: 1, loseWeight: 0, activate: true, prizes: [{ name: "Content Pack", value: "£320", quantity: 5, weight: 1 }], ...overrides });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; prizes: { id: string }[] };
}

describe("offers", () => {
  it("Super Admin manages offers; customers only see published ones within the window", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const draft = await api().post("/api/v1/offers").set(admin.auth).send(offerBody);
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ status: "DRAFT", stats: { totalViews: 0 } });
    expect((await api().post("/api/v1/offers").set(ctx.auth).send(offerBody)).status).toBe(403);

    expect((await api().get("/api/v1/offers").set(ctx.auth)).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/offers/${draft.body.data.id}`).set(ctx.auth)).status).toBe(404);

    const published = await api().post(`/api/v1/offers/${draft.body.data.id}/publish`).set(admin.auth);
    expect(published.body.data.status).toBe("PUBLISHED");
    const visible = await api().get("/api/v1/offers").set(ctx.auth);
    expect(visible.body.data).toHaveLength(1);
    expect(visible.body.data[0].stats).toBeUndefined();

    await api().patch(`/api/v1/offers/${draft.body.data.id}`).set(admin.auth).send({ endsAt: new Date(Date.now() - 1000).toISOString() });
    expect((await api().get("/api/v1/offers").set(ctx.auth)).body.data).toHaveLength(0);
  });

  it("counts one view per user per window and reports unique viewers", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const second = await createUser({ companyId: ctx.company.id, companyRole: "VIEWER" });
    const secondTokens = await login(second.email, second.password);
    const offer = (await api().post("/api/v1/offers").set(admin.auth).send(offerBody)).body.data;
    await api().post(`/api/v1/offers/${offer.id}/publish`).set(admin.auth);

    const first = await api().post(`/api/v1/offers/${offer.id}/view`).set(ctx.auth);
    expect(first.status).toBe(202);
    expect(first.body.data.recorded).toBe(true);
    const repeat = await api().post(`/api/v1/offers/${offer.id}/view`).set(ctx.auth);
    expect(repeat.body.data.recorded).toBe(false);
    await api().post(`/api/v1/offers/${offer.id}/view`).set("Authorization", `Bearer ${secondTokens.accessToken}`);

    const stats = await api().get(`/api/v1/offers/${offer.id}/stats`).set(admin.auth);
    expect(stats.body.data).toMatchObject({ totalViews: 2, uniqueViewers: 2, byCompany: [{ companyId: ctx.company.id, views: 2 }] });
    expect(stats.body.data.lastViewedAt).toBeTypeOf("string");
    expect((await api().get(`/api/v1/offers/${offer.id}/stats`).set(ctx.auth)).status).toBe(403);
  });
});

describe("scratch campaigns", () => {
  it("enforces active window, offers-visit prerequisite, and attempt limits", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const draft = (await api().post("/api/v1/campaigns").set(admin.auth).send({ title: "Draft Draw", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), prizes: [{ name: "P", quantity: 1 }] })).body.data;
    expect(draft.status).toBe("DRAFT");
    expect((await api().get("/api/v1/campaigns").set(ctx.auth)).body.data).toHaveLength(0);
    const inactive = await api().post(`/api/v1/campaigns/${draft.id}/attempts`).set(ctx.auth).set("Idempotency-Key", "a0");
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe("CAMPAIGN_INACTIVE");

    const gated = await activeCampaign(admin, { requireOffersVisit: true });
    const elig = await api().get(`/api/v1/campaigns/${gated.id}/eligibility`).set(ctx.auth);
    expect(elig.body.data).toMatchObject({ eligible: false, reason: "OFFERS_VISIT_REQUIRED", attemptsRemaining: 1 });
    const blocked = await api().post(`/api/v1/campaigns/${gated.id}/attempts`).set(ctx.auth).set("Idempotency-Key", "a1");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("OFFERS_VISIT_REQUIRED");

    const offer = (await api().post("/api/v1/offers").set(admin.auth).send(offerBody)).body.data;
    await api().post(`/api/v1/offers/${offer.id}/publish`).set(admin.auth);
    await api().post(`/api/v1/offers/${offer.id}/view`).set(ctx.auth);
    const win = await api().post(`/api/v1/campaigns/${gated.id}/attempts`).set(ctx.auth).set("Idempotency-Key", "a2");
    expect(win.status).toBe(200);
    expect(win.body.data).toMatchObject({ outcome: "WIN", prize: { name: "Content Pack" }, attemptsRemaining: 0 });

    const exhausted = await api().post(`/api/v1/campaigns/${gated.id}/attempts`).set(ctx.auth).set("Idempotency-Key", "a3");
    expect(exhausted.status).toBe(409);
    expect(exhausted.body.error.code).toBe("ATTEMPTS_EXHAUSTED");
    const replay = await api().post(`/api/v1/campaigns/${gated.id}/attempts`).set(ctx.auth).set("Idempotency-Key", "a2");
    expect(replay.status).toBe(200);
    expect(replay.body.data.attemptId).toBe(win.body.data.attemptId);
    expect(await prisma.scratchAttempt.count()).toBe(1);

    // Reopening the campaign later still shows what the user won.
    const later = await api().get(`/api/v1/campaigns/${gated.id}/eligibility`).set(ctx.auth);
    expect(later.body.data).toMatchObject({ eligible: false, reason: "ATTEMPTS_EXHAUSTED", attemptsRemaining: 0 });
    expect(later.body.data.attempts).toEqual([{ attemptId: win.body.data.attemptId, outcome: "WIN", prize: { id: expect.any(String), name: "Content Pack", value: "£320" }, redemption: "PENDING", createdAt: expect.any(String) }]);
    const someoneElse = await customerContext();
    expect((await api().get(`/api/v1/campaigns/${gated.id}/eligibility`).set(someoneElse.auth)).body.data.attempts).toEqual([]);
  });

  it("never awards more prizes than exist under concurrent attempts", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const campaign = await activeCampaign(admin, { maxAttempts: 1, prizes: [{ name: "Scarce", quantity: 5, weight: 1 }] });
    const users = await Promise.all(Array.from({ length: 40 }, () => createUser({ companyId: ctx.company.id, companyRole: "VIEWER" })));
    const results = await Promise.all(users.map((u, i) => api().post(`/api/v1/campaigns/${campaign.id}/attempts`).set("Authorization", `Bearer ${tokenFor(u)}`).set("Idempotency-Key", `c-${i}`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const wins = results.filter((r) => r.body.data.outcome === "WIN").length;
    expect(wins).toBe(5);
    expect(await prisma.scratchWinner.count()).toBe(5);
    expect((await prisma.scratchPrize.findUnique({ where: { id: campaign.prizes[0]!.id } }))?.remaining).toBe(0);
    const detail = await api().get(`/api/v1/campaigns/${campaign.id}`).set(admin.auth);
    expect(detail.body.data).toMatchObject({ attempts: 40, winners: 5, prizes: [{ remaining: 0, awarded: 5 }] });
  });

  it("lists winners for the Super Admin and redeems idempotently", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const campaign = await activeCampaign(admin);
    await api().post(`/api/v1/campaigns/${campaign.id}/attempts`).set(ctx.auth).set("Idempotency-Key", "w1");
    expect((await api().get("/api/v1/winners").set(ctx.auth)).status).toBe(403);
    const winners = await api().get("/api/v1/winners").set(admin.auth);
    expect(winners.body.data).toHaveLength(1);
    expect(winners.body.data[0]).toMatchObject({ user: { email: ctx.user.email }, company: { id: ctx.company.id }, campaign: { title: "Summer Draw" }, prize: { name: "Content Pack" }, redemption: "PENDING" });
    const id = winners.body.data[0].id;
    const r1 = await api().post(`/api/v1/winners/${id}/redeem`).set(admin.auth);
    expect(r1.body.data.redemption).toBe("REDEEMED");
    const r2 = await api().post(`/api/v1/winners/${id}/redeem`).set(admin.auth);
    expect(r2.body.data.redeemedAt).toBe(r1.body.data.redeemedAt);
    const removePrize = await api().delete(`/api/v1/campaigns/${campaign.id}/prizes/${campaign.prizes[0]!.id}`).set(admin.auth);
    expect(removePrize.body.error.code).toBe("PRIZE_AWARDED");
  });
});

describe("campaign input validation", () => {
  it("rejects a past start, an end before the start, and too many prizes", async () => {
    const admin = await superAdminContext();
    const base = { title: "Winter Draw", startsAt: new Date(Date.now() + 3600_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), prizes: [{ name: "Mug", quantity: 1 }] };
    const past = await api().post("/api/v1/campaigns").set(admin.auth).send({ ...base, startsAt: "2020-01-01T00:00:00Z" });
    expect(past.body.error.details).toContainEqual({ path: "body.startsAt", message: "The start can't be in the past" });
    const reversed = await api().post("/api/v1/campaigns").set(admin.auth).send({ ...base, endsAt: new Date(Date.now() + 60_000).toISOString() });
    expect(reversed.body.error.details).toEqual([{ path: "body.endsAt", message: "Must be after the start" }]);
    const many = await api().post("/api/v1/campaigns").set(admin.auth).send({ ...base, prizes: Array.from({ length: 51 }, (_, i) => ({ name: `P${i}`, quantity: 1 })) });
    expect(many.body.error.details[0].path).toBe("body.prizes");
    const created = await api().post("/api/v1/campaigns").set(admin.auth).send(base);
    expect(created.status).toBe(201);
    const patch = await api().patch(`/api/v1/campaigns/${created.body.data.id}`).set(admin.auth).send({ startsAt: "2031-02-01T00:00:00Z", endsAt: "2031-01-01T00:00:00Z" });
    expect(patch.body.error.details).toEqual([{ path: "body.endsAt", message: "Must be after the start" }]);
  });
});
