import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { noopPush, setPushProvider } from "../../core/push/index.js";
import { touchPresence } from "../../core/redis/presence.js";
import { notificationSend } from "../../jobs/notification.send.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(async () => { await resetDatabase(); noopPush.sent.length = 0; setPushProvider(noopPush); });
afterAll(closeAll);

async function pairedScreen(auth: Record<string, string>, name: string, orientation = "LANDSCAPE") {
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 8)}` })).body.data;
  const screen = (await api().post("/api/v1/screens/pair").set(auth).send({ code: session.code, name, orientation })).body.data as { id: string };
  const credential = (await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`)).body.data.credential as string;
  return { ...screen, credential };
}

describe("notifications", () => {
  it("registers subscriptions, resolves audiences, and sends through the provider", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const other = await customerContext();
    expect((await api().post("/api/v1/notifications/subscriptions").set(ctx.auth).send({ externalId: "onesignal-player-1", platform: "android" })).status).toBe(201);
    await api().post("/api/v1/notifications/subscriptions").set(other.auth).send({ externalId: "onesignal-player-2" });
    expect((await api().post("/api/v1/notifications").set(ctx.auth).send({ title: "Hi", body: "No", audience: { kind: "all" } })).status).toBe(403);

    const res = await api().post("/api/v1/notifications").set(admin.auth).send({ title: "New offer", body: "Display upgrade programme is live", audience: { kind: "companies", companyIds: [ctx.company.id] }, deepLink: "/portal/offers/abc" });
    expect(res.status).toBe(202);
    expect(res.body.data.sentAt).toBeNull();
    await notificationSend({ notificationId: res.body.data.id });
    expect(noopPush.sent).toHaveLength(1);
    expect(noopPush.sent[0]!.audience.externalIds).toEqual(["onesignal-player-1"]);
    expect(noopPush.sent[0]!.message).toMatchObject({ title: "New offer", deepLink: "/portal/offers/abc" });
    const list = await api().get("/api/v1/notifications").set(admin.auth);
    expect(list.body.data[0].sentAt).toBeTypeOf("string");
  });
});

describe("activity", () => {
  it("customers see only their company; Super Admin filters across tenants", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const other = await customerContext();
    await pairedScreen(ctx.auth, "Mine");
    await pairedScreen(other.auth, "Theirs");
    const mine = await api().get("/api/v1/activity").set(ctx.auth);
    expect(mine.body.data.every((a: { company: { id: string } }) => a.company.id === ctx.company.id)).toBe(true);
    expect(mine.body.data.map((a: { action: string }) => a.action)).toContain("screen.paired");
    const all = await api().get("/api/v1/activity?action=screen.").set(admin.auth);
    expect(all.body.meta.total).toBe(2);
    const filtered = await api().get(`/api/v1/activity?companyId=${other.company.id}`).set(admin.auth);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0]).toMatchObject({ summary: expect.stringContaining("Theirs"), actor: { role: "ADMIN" } });
  });
});

describe("synchronized canvas", () => {
  it("validates members, reports readiness, blocks degraded activation, then activates with a shared activate_at", async () => {
    const ctx = await customerContext({ screenLimit: 5 });
    const a = await pairedScreen(ctx.auth, "Left");
    const b = await pairedScreen(ctx.auth, "Right");
    const portrait = await pairedScreen(ctx.auth, "Tall", "PORTRAIT");
    const mismatch = await api().post("/api/v1/canvas").set(ctx.auth).send({ name: "Wall", screenIds: [a.id, portrait.id] });
    expect(mismatch.body.error.code).toBe("ORIENTATION_MISMATCH");
    const tooFew = await api().post("/api/v1/canvas").set(ctx.auth).send({ name: "Wall", screenIds: [a.id] });
    expect(tooFew.status).toBe(400);

    const created = await api().post("/api/v1/canvas").set(ctx.auth).send({ name: "Lobby Wall", screenIds: [a.id, b.id] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: "DRAFT", readyCount: 0, members: [{ position: 0, name: "Left", ready: false }, { position: 1, name: "Right" }] });
    const id = created.body.data.id;
    const dup = await api().post("/api/v1/canvas").set(ctx.auth).send({ name: "Another", screenIds: [a.id, b.id] });
    expect(dup.body.error.code).toBe("SCREEN_IN_CANVAS");

    const asset = await prisma.mediaAsset.create({ data: { companyId: ctx.company.id, name: "wide.jpg", type: "IMAGE", status: "READY", mimeType: "image/jpeg", sizeBytes: BigInt(1), storageKey: `${ctx.company.id}/wide` } });
    const playlist = await prisma.playlist.create({ data: { companyId: ctx.company.id, name: "Wide", items: { create: [{ position: 0, assetId: asset.id, durationSec: 10 }] } } });
    const noContent = await api().post(`/api/v1/canvas/${id}/activate`).set(ctx.auth).set("Idempotency-Key", "cv0");
    expect(noContent.body.error.code).toBe("NO_CONTENT");
    await api().patch(`/api/v1/canvas/${id}`).set(ctx.auth).send({ content: { kind: "PLAYLIST", refId: playlist.id } });

    await touchPresence(a.id);
    const degraded = await api().post(`/api/v1/canvas/${id}/activate`).set(ctx.auth).set("Idempotency-Key", "cv1");
    expect(degraded.status).toBe(409);
    expect(degraded.body.error.code).toBe("CANVAS_DEGRADED");
    expect(degraded.body.error.details.members).toEqual(["Right"]);

    await touchPresence(b.id);
    const active = await api().post(`/api/v1/canvas/${id}/activate`).set(ctx.auth).set("Idempotency-Key", "cv2");
    expect(active.status).toBe(200);
    expect(active.body.data.status).toBe("ACTIVE");
    expect(new Date(active.body.data.activateAt).getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.screenAssignment.count({ where: { kind: "CANVAS", refId: id } })).toBe(2);
    const manifest = await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${a.credential}`);
    expect(manifest.body.data.canvas).toMatchObject({ setId: id, position: 0, total: 2 });
    expect(manifest.body.data.activateAt).toBe(active.body.data.activateAt);

    expect((await api().delete(`/api/v1/canvas/${id}`).set(ctx.auth)).body.error.code).toBe("CANVAS_ACTIVE");
    await api().post(`/api/v1/canvas/${id}/deactivate`).set(ctx.auth);
    expect((await api().delete(`/api/v1/canvas/${id}`).set(ctx.auth)).status).toBe(204);
  });
});
