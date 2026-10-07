import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";
import { pngBytes } from "../../test/media.js";
import { broadcastWindowSweep } from "./broadcasts.service.js";

beforeEach(resetDatabase);
afterAll(closeAll);

type Admin = Awaited<ReturnType<typeof superAdminContext>>;

/** A location in a new category with one paired screen; returns a manifest reader for it. */
async function locationWithScreen(admin: Admin, categoryName: string) {
  const category = (await api().post("/api/v1/categories").set(admin.auth).send({ name: categoryName })).body.data;
  const ctx = await customerContext();
  await api().patch(`/api/v1/companies/${ctx.company.id}`).set(admin.auth).send({ categoryId: category.id });
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${categoryName}` })).body.data;
  await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "Counter" });
  const credential = (await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`)).body.data.credential;
  const manifest = async () => (await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${credential}`)).body.data as { version: number; items: { assetId: string; durationSec: number }[]; assets: { id: string; url: string; type: string }[] };
  return { ctx, category, manifest };
}

async function uploadPicture(admin: Admin) {
  const bytes = await pngBytes(64, 64, "#ff0000");
  const up = await api().post("/api/v1/broadcasts/upload-url").set(admin.auth).send({ fileName: "gum.png", contentType: "image/png", sizeBytes: bytes.length });
  expect(up.status).toBe(201);
  expect((await fetch(up.body.data.uploadUrl, { method: "PUT", body: bytes, headers: { "Content-Type": "image/png" } })).status).toBe(200);
  return up.body.data.key as string;
}

describe("Head Office push", () => {
  it("puts a picture on the screens of the chosen category, and takes it off when paused or deleted", async () => {
    const admin = await superAdminContext();
    const bar = await locationWithScreen(admin, "Restaurant");
    const kiosk = await locationWithScreen(admin, "Kiosk");
    const before = await bar.manifest();
    expect(before.items).toEqual([]);

    const fileKey = await uploadPicture(admin);
    const push = await api().post("/api/v1/broadcasts").set(admin.auth).send({ title: "Extra Gum", fileKey, displaySec: 8, audience: { kind: "categories", categoryIds: [bar.category.id] } });
    expect(push.status).toBe(201);
    expect(push.body.data).toMatchObject({ status: "LIVE", type: "IMAGE", screens: 1, displaySec: 8 });

    const live = await bar.manifest();
    expect(live.version).toBeGreaterThan(before.version);
    expect(live.items).toEqual([{ assetId: push.body.data.id, position: 0, durationSec: 8 }]);
    expect((await fetch(live.assets[0]!.url)).status).toBe(200);
    expect((await kiosk.manifest()).items).toEqual([]);

    const paused = await api().patch(`/api/v1/broadcasts/${push.body.data.id}`).set(admin.auth).send({ active: false });
    expect(paused.body.data.status).toBe("PAUSED");
    expect((await bar.manifest()).items).toEqual([]);
    await api().patch(`/api/v1/broadcasts/${push.body.data.id}`).set(admin.auth).send({ active: true });
    expect((await bar.manifest()).items).toHaveLength(1);

    expect((await api().delete(`/api/v1/broadcasts/${push.body.data.id}`).set(admin.auth)).status).toBe(204);
    expect((await bar.manifest()).items).toEqual([]);
  });

  it("plays after the location's own content", async () => {
    const admin = await superAdminContext();
    const bar = await locationWithScreen(admin, "Restaurant");
    const own = await prisma.mediaAsset.create({ data: { companyId: bar.ctx.company.id, name: "menu.png", type: "IMAGE", status: "READY", mimeType: "image/png", sizeBytes: BigInt(1), storageKey: `${bar.ctx.company.id}/menu.png` } });
    const playlist = (await api().post("/api/v1/playlists").set(bar.ctx.auth).send({ name: "Menu", items: [{ assetId: own.id, durationSec: 20 }] })).body.data;
    const screen = await prisma.screen.findFirstOrThrow({ where: { companyId: bar.ctx.company.id } });
    await api().post(`/api/v1/playlists/${playlist.id}/publish`).set(bar.ctx.auth).set("Idempotency-Key", "p1").send({ screenIds: [screen.id] });
    const push = (await api().post("/api/v1/broadcasts").set(admin.auth).send({ title: "Extra Gum", fileKey: await uploadPicture(admin) })).body.data;
    expect((await bar.manifest()).items).toEqual([{ assetId: own.id, position: 0, durationSec: 20 }, { assetId: push.id, position: 1, durationSec: 10 }]);
  });

  it("starts and stops on time", async () => {
    const admin = await superAdminContext();
    const bar = await locationWithScreen(admin, "Restaurant");
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const push = (await api().post("/api/v1/broadcasts").set(admin.auth).send({ title: "Weekend", fileKey: await uploadPicture(admin), startsAt: tomorrow })).body.data;
    expect(push.status).toBe("SCHEDULED");
    expect((await bar.manifest()).items).toEqual([]);

    await prisma.broadcast.update({ where: { id: push.id }, data: { startsAt: new Date(Date.now() - 1000) } });
    const v0 = (await bar.manifest()).version;
    expect(await broadcastWindowSweep()).toBe(1);
    const started = await bar.manifest();
    expect([started.version > v0, started.items.length]).toEqual([true, 1]);
    expect(await broadcastWindowSweep()).toBe(0);

    await prisma.broadcast.update({ where: { id: push.id }, data: { endsAt: new Date(Date.now() - 500) } });
    expect(await broadcastWindowSweep()).toBe(1);
    expect((await bar.manifest()).items).toEqual([]);
  });

  it("pushes a template that has all its Head Office values, and refuses one that needs a location's", async () => {
    const admin = await superAdminContext();
    const bar = await locationWithScreen(admin, "Restaurant");
    const ready = (await api().post("/api/v1/templates").set(admin.auth).send({ name: "Gum", category: "Promotion", fields: [{ key: "title", label: "Headline", type: "text", locked: true, default: "Extra Gum" }, { key: "price", label: "Price", type: "text", required: true, default: "10 kr" }] })).body.data;
    const push = await api().post("/api/v1/broadcasts").set(admin.auth).send({ title: "Gum push", templateId: ready.id });
    expect(push.status).toBe(201);
    expect(push.body.data).toMatchObject({ source: "TEMPLATE", type: "IMAGE", mimeType: "image/png" });
    expect((await bar.manifest()).items).toHaveLength(1);

    const open = (await api().post("/api/v1/templates").set(admin.auth).send({ name: "Price card", category: "Promotion", fields: [{ key: "price", label: "Price", type: "text", required: true }] })).body.data;
    const refused = await api().post("/api/v1/broadcasts").set(admin.auth).send({ title: "Price push", templateId: open.id });
    expect([refused.status, refused.body.error.code]).toEqual([400, "TEMPLATE_NEEDS_VALUES"]);
    expect(refused.body.error.message).toContain("Price");
  });

  it("is for the Super Admin only and checks what it pushes", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    expect((await api().get("/api/v1/broadcasts").set(ctx.auth)).status).toBe(403);
    const missing = await api().post("/api/v1/broadcasts").set(admin.auth).send({ title: "Ghost", fileKey: "head-office/broadcasts/nope/x.png" });
    expect([missing.status, missing.body.error.code]).toEqual([400, "UPLOAD_MISSING"]);
    const both = await api().post("/api/v1/broadcasts").set(admin.auth).send({ title: "Both", fileKey: "head-office/broadcasts/a.png", templateId: "cmissing0000000000000000a" });
    expect(both.status).toBe(400);
  });
});
