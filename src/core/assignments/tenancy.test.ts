import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import { customerContext, superAdminContext, MISSING_ID } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

async function pairedScreen(auth: Record<string, string>, name = "Screen") {
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 10)}` })).body.data;
  const screen = (await api().post("/api/v1/screens/pair").set(auth).send({ code: session.code, name })).body.data as { id: string };
  const credential = (await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`)).body.data.credential as string;
  return { ...screen, credential };
}

const image = (companyId: string, name = "a.jpg") =>
  prisma.mediaAsset.create({ data: { companyId, name, type: "IMAGE", status: "READY", mimeType: "image/jpeg", sizeBytes: BigInt(1), storageKey: `${companyId}/${name}-${Math.random()}` } });

describe("cross-tenant references", () => {
  it("refuses canvas content from another company, with a field path", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const a = await pairedScreen(ctx.auth, "Left");
    const b = await pairedScreen(ctx.auth, "Right");
    const canvas = (await api().post("/api/v1/canvas").set(ctx.auth).send({ name: "Wall", screenIds: [a.id, b.id] })).body.data;
    const theirs = await prisma.playlist.create({ data: { companyId: other.company.id, name: "Theirs" } });
    const res = await api().patch(`/api/v1/canvas/${canvas.id}`).set(ctx.auth).send({ content: { kind: "PLAYLIST", refId: theirs.id } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "CONTENT_NOT_FOUND", details: [{ path: "body.content.refId" }] });
    const layout = await api().patch(`/api/v1/canvas/${canvas.id}`).set(ctx.auth).send({ content: { kind: "LAYOUT", refId: MISSING_ID } });
    expect(layout.body.error.code).toBe("CONTENT_NOT_FOUND");
    expect((await prisma.canvasSet.findUnique({ where: { id: canvas.id } }))?.contentRef).toBeNull();
  });

  it("never loads another company's content into a manifest, even for a forged assignment", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const screen = await pairedScreen(ctx.auth);
    const asset = await image(other.company.id);
    const theirs = await prisma.playlist.create({ data: { companyId: other.company.id, name: "Secret", items: { create: [{ position: 0, assetId: asset.id, durationSec: 5 }] } } });
    await prisma.screenAssignment.create({ data: { screenId: screen.id, kind: "PLAYLIST", refId: theirs.id, version: 1 } });
    const m = (await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${screen.credential}`)).body.data;
    expect(m.assignment).toBeNull();
    expect(m.items).toEqual([]);
    expect(m.assets).toEqual([]);
  });

  it("refuses publishing to another company's screen group", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const screen = await pairedScreen(ctx.auth);
    const foreign = await pairedScreen(other.auth);
    const group = (await api().post("/api/v1/screen-groups").set(other.auth).send({ name: "Theirs", screenIds: [foreign.id] })).body.data;
    const asset = await image(ctx.company.id);
    const p = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "P", items: [{ assetId: asset.id, durationSec: 5 }] })).body.data;
    const res = await api().post(`/api/v1/playlists/${p.id}/publish`).set(ctx.auth).set("Idempotency-Key", "g1").send({ screenIds: [screen.id], groupIds: [group.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "GROUP_NOT_FOUND", details: [{ path: "body.groupIds" }] });
    expect(await prisma.screenAssignment.count()).toBe(0);
  });

  it("only accepts storage keys of ready library images for offers and campaign artwork", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const offer = { title: "Bundle deal", category: "Hardware", summary: "Two screens for one price", description: "Buy one display and get one free", instructions: "Call us", contact: { name: "Sales" } };
    const bad = await api().post("/api/v1/offers").set(admin.auth).send({ ...offer, imageKey: "some-other-company/secret.pdf" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "MEDIA_KEY_INVALID", details: [{ path: "body.imageKey" }] });
    const img = await image(ctx.company.id);
    const good = await api().post("/api/v1/offers").set(admin.auth).send({ ...offer, imageKey: img.storageKey });
    expect(good.status).toBe(201);
    const patched = await api().patch(`/api/v1/offers/${good.body.data.id}`).set(admin.auth).send({ imageKey: "x/y.png" });
    expect(patched.body.error.code).toBe("MEDIA_KEY_INVALID");

    const window = { startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() };
    const campaign = await api().post("/api/v1/campaigns").set(admin.auth).send({ title: "Spring", ...window, artworkKey: "not/a/key.png", prizes: [{ name: "Mug", quantity: 1 }] });
    expect(campaign.status).toBe(400);
    expect(campaign.body.error).toMatchObject({ code: "MEDIA_KEY_INVALID", details: [{ path: "body.artworkKey" }] });
  });

  it("refuses notification audiences naming companies or users that don't exist", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const res = await api().post("/api/v1/notifications").set(admin.auth).send({ title: "Hello", body: "Hello there", audience: { kind: "companies", companyIds: [ctx.company.id, MISSING_ID] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "AUDIENCE_NOT_FOUND", details: [{ path: "body.audience.companyIds.1" }] });
    const users = await api().post("/api/v1/notifications").set(admin.auth).send({ title: "Hello", body: "Hello there", audience: { kind: "users", userIds: [MISSING_ID] } });
    expect(users.body.error.code).toBe("AUDIENCE_NOT_FOUND");
    expect(await prisma.notification.count()).toBe(0);
  });
});
