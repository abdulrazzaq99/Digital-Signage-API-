import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { noopPush, setPushProvider } from "../../core/push/index.js";
import { OneSignalProvider } from "../../core/push/onesignal.js";
import { notificationSend } from "../../jobs/notification.send.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(async () => { await resetDatabase(); noopPush.sent.length = 0; setPushProvider(noopPush); });
afterEach(() => vi.unstubAllGlobals());
afterAll(closeAll);

const offer = () => prisma.offer.create({ data: { title: "Bundle deal", category: "Hardware", summary: "Two screens for one", description: "Buy one get one free on displays", instructions: "Call us", contact: { name: "Sales" } } });

describe("sending", () => {
  it("registers subscriptions, resolves audiences, and sends the push contract through the provider", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const other = await customerContext();
    expect((await api().post("/api/v1/notifications/subscriptions").set(ctx.auth).send({ externalId: "onesignal-sub-1", platform: "android" })).status).toBe(201);
    await api().post("/api/v1/notifications/subscriptions").set(other.auth).send({ externalId: "onesignal-sub-2" });
    expect((await api().post("/api/v1/notifications").set(ctx.auth).send({ title: "Hi", body: "No", audience: { kind: "all" } })).status).toBe(403);

    const res = await api().post("/api/v1/notifications").set(admin.auth).send({ title: "Maintenance", body: "Players restart tonight at 2am", audience: { kind: "companies", companyIds: [ctx.company.id] }, deepLink: "/portal/notifications" });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ type: "announcement", targetId: null, sentAt: null });
    await notificationSend({ notificationId: res.body.data.id });
    expect(noopPush.sent).toHaveLength(1);
    expect(noopPush.sent[0]!.audience.externalIds).toEqual(["onesignal-sub-1"]);
    // A relative web path is not a web push URL, so only the app link goes out.
    expect(noopPush.sent[0]!.message).toEqual({ title: "Maintenance", body: "Players restart tonight at 2am", data: { notificationId: res.body.data.id, type: "announcement" }, appUrl: `dsp://notifications/${res.body.data.id}`, idempotencyKey: res.body.data.id });
    const list = await api().get("/api/v1/notifications").set(admin.auth);
    expect(list.body.data[0].sentAt).toBeTypeOf("string");
  });

  it("an offer notification carries its type, target and deep links", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    await api().post("/api/v1/notifications/subscriptions").set(ctx.auth).send({ externalId: "onesignal-sub-1" });
    const o = await offer();
    const res = await api().post("/api/v1/notifications").set(admin.auth).send({ title: "New offer", body: "Two screens for one", type: "offer", targetId: o.id, audience: { kind: "all" }, deepLink: "https://signage.example.com/portal/offers" });
    expect(res.status).toBe(202);
    await notificationSend({ notificationId: res.body.data.id });
    expect(noopPush.sent[0]!.message).toMatchObject({ data: { notificationId: res.body.data.id, type: "offer", targetId: o.id }, appUrl: `dsp://offers/${o.id}`, webUrl: "https://signage.example.com/portal/offers" });
  });

  it("rejects an offer or campaign notification without a real target", async () => {
    const admin = await superAdminContext();
    const missing = await api().post("/api/v1/notifications").set(admin.auth).send({ title: "New offer", body: "Something", type: "offer", audience: { kind: "all" } });
    expect(missing.status).toBe(400);
    const unknown = await api().post("/api/v1/notifications").set(admin.auth).send({ title: "Play now", body: "Scratch to win", type: "campaign", targetId: "nope", audience: { kind: "all" } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("TARGET_NOT_FOUND");
  });

  it("drops subscriptions the provider reports as invalid", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    await api().post("/api/v1/notifications/subscriptions").set(ctx.auth).send({ externalId: "onesignal-good" });
    await api().post("/api/v1/notifications/subscriptions").set(ctx.auth).send({ externalId: "onesignal-gone" });
    setPushProvider({ name: "fake", send: async (_m, a) => ({ providerId: "p1", recipients: a.externalIds.length - 1, invalidIds: ["onesignal-gone"] }) });
    const res = await api().post("/api/v1/notifications").set(admin.auth).send({ title: "Hello", body: "Everyone", audience: { kind: "all" } });
    await notificationSend({ notificationId: res.body.data.id });
    expect((await prisma.pushSubscription.findMany()).map((s) => s.externalId)).toEqual(["onesignal-good"]);
  });
});

describe("OneSignal provider", () => {
  it("uses the current API: Key auth, subscription IDs in batches, data and app/web URLs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: "os-1", errors: { invalid_player_ids: ["c"] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OneSignalProvider("app-1", "key-1", 2);
    const result = await provider.send({ title: "T", body: "B", data: { notificationId: "n1", type: "offer", targetId: "o1" }, appUrl: "dsp://offers/o1", webUrl: "https://x.test/offers", idempotencyKey: "n1" }, { externalIds: ["a", "b", "c"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.onesignal.com/notifications?c=push");
    expect((init.headers as Record<string, string>).Authorization).toBe("Key key-1");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ app_id: "app-1", target_channel: "push", include_subscription_ids: ["a", "b"], headings: { en: "T" }, contents: { en: "B" }, data: { notificationId: "n1", type: "offer", targetId: "o1" }, app_url: "dsp://offers/o1", web_url: "https://x.test/offers" });
    expect(body.url).toBeUndefined();
    expect(body.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).include_subscription_ids).toEqual(["c"]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).idempotency_key).not.toBe(body.idempotency_key);
    expect(result).toEqual({ providerId: "os-1", recipients: 2, invalidIds: ["c"] });
  });

  it("throws on a rejected request so the job retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: ["Forbidden"] }), { status: 403 })));
    await expect(new OneSignalProvider("app-1", "bad").send({ title: "T", body: "B" }, { externalIds: ["a"] })).rejects.toThrow(/403/);
  });
});

describe("inbox", () => {
  it("shows a user the sent notifications addressed to everyone, their company or them", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const other = await customerContext();
    const send = async (title: string, audience: unknown, deliver = true) => {
      const res = await api().post("/api/v1/notifications").set(admin.auth).send({ title, body: "Body text", audience });
      if (deliver) await notificationSend({ notificationId: res.body.data.id });
      return res.body.data.id as string;
    };
    const all = await send("For everyone", { kind: "all" });
    const mine = await send("For my company", { kind: "companies", companyIds: [ctx.company.id] });
    const me = await send("For me", { kind: "users", userIds: [ctx.user.id] });
    const theirs = await send("For them", { kind: "companies", companyIds: [other.company.id] });
    await send("Not sent yet", { kind: "all" }, false);

    const inbox = await api().get("/api/v1/notifications/inbox").set(ctx.auth);
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.map((n: { id: string }) => n.id).sort()).toEqual([all, mine, me].sort());
    expect(inbox.body.meta.total).toBe(3);
    expect(inbox.body.data[0]).not.toHaveProperty("audience");
    expect(inbox.body.data[0]).toMatchObject({ type: "announcement", targetId: null, sentAt: expect.any(String) });

    expect((await api().get(`/api/v1/notifications/${mine}`).set(ctx.auth)).body.data).toMatchObject({ id: mine, title: "For my company", body: "Body text" });
    expect((await api().get(`/api/v1/notifications/${theirs}`).set(ctx.auth)).status).toBe(404);
    expect((await api().get(`/api/v1/notifications/${theirs}`).set(admin.auth)).status).toBe(200);
  });
});
