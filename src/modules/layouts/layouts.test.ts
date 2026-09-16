import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { templateRender } from "../../jobs/template.render.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(async () => {
  await resetDatabase();
  await prisma.layout.create({ data: { presetId: "main-bottom-bar", name: "Main + Bottom Bar", isPreset: true, zones: { create: [{ index: 0, name: "Main Content", x: 0, y: 0, w: 1, h: 0.75 }, { index: 1, name: "Bottom Bar", x: 0, y: 0.75, w: 1, h: 0.25 }] } } });
  await prisma.template.create({ data: { name: "Flash Sale", category: "Retail", isGlobal: true, fields: [{ key: "headline", label: "Headline", type: "text", required: true, max: 10 }, { key: "accent", label: "Accent", type: "color" }] } });
});
afterAll(closeAll);

async function readyAsset(companyId: string) {
  return prisma.mediaAsset.create({ data: { companyId, name: "a.jpg", type: "IMAGE", status: "READY", mimeType: "image/jpeg", sizeBytes: BigInt(1), storageKey: `${companyId}/a-${Math.random()}` } });
}
async function pairedScreen(auth: Record<string, string>) {
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 8)}` })).body.data;
  return (await api().post("/api/v1/screens/pair").set(auth).send({ code: session.code, name: "Screen" })).body.data as { id: string };
}

describe("layouts", () => {
  it("copies preset zones, binds media and playlists, gates publish on unassigned zones", async () => {
    const ctx = await customerContext();
    const presets = await api().get("/api/v1/layouts/presets").set(ctx.auth);
    expect(presets.body.data[0]).toMatchObject({ presetId: "main-bottom-bar", isPreset: true, zones: [{ index: 0, w: 1, h: 0.75 }, { index: 1 }] });

    const bad = await api().post("/api/v1/layouts").set(ctx.auth).send({ presetId: "nope", name: "X" });
    expect(bad.body.error.code).toBe("PRESET_NOT_FOUND");
    const created = await api().post("/api/v1/layouts").set(ctx.auth).send({ presetId: "main-bottom-bar", name: "Lobby Layout" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ isPreset: false, ready: false, zones: [{ binding: null }, { binding: null }] });
    const id = created.body.data.id;

    const screen = await pairedScreen(ctx.auth);
    const blocked = await api().post(`/api/v1/layouts/${id}/publish`).set(ctx.auth).set("Idempotency-Key", "l1").send({ screenIds: [screen.id] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe("ZONES_UNASSIGNED");
    expect(blocked.body.error.details.zones).toEqual(["Main Content", "Bottom Bar"]);

    const asset = await readyAsset(ctx.company.id);
    const playlist = await prisma.playlist.create({ data: { companyId: ctx.company.id, name: "Ticker", items: { create: [{ position: 0, assetId: asset.id, durationSec: 5 }] } } });
    await api().put(`/api/v1/layouts/${id}/zones/0`).set(ctx.auth).send({ bindingKind: "MEDIA", refId: asset.id });
    const bound = await api().put(`/api/v1/layouts/${id}/zones/1`).set(ctx.auth).send({ bindingKind: "PLAYLIST", refId: playlist.id });
    expect(bound.body.data).toMatchObject({ ready: true, zones: [{ bindingKind: "MEDIA", binding: { id: asset.id } }, { bindingKind: "PLAYLIST", binding: { name: "Ticker" } }] });

    const other = await customerContext();
    const foreignAsset = await readyAsset(other.company.id);
    const foreign = await api().put(`/api/v1/layouts/${id}/zones/0`).set(ctx.auth).send({ bindingKind: "MEDIA", refId: foreignAsset.id });
    expect(foreign.body.error.code).toBe("ASSET_NOT_FOUND");
    expect((await api().get(`/api/v1/layouts/${id}`).set(other.auth)).status).toBe(404);

    const pub = await api().post(`/api/v1/layouts/${id}/publish`).set(ctx.auth).set("Idempotency-Key", "l2").send({ screenIds: [screen.id] });
    expect(pub.status).toBe(200);
    expect(await prisma.screenAssignment.findUnique({ where: { screenId: screen.id } })).toMatchObject({ kind: "LAYOUT", refId: id, version: 1 });
    const del = await api().delete(`/api/v1/layouts/${id}`).set(ctx.auth);
    expect(del.body.error.code).toBe("LAYOUT_IN_USE");
  });
});

describe("templates", () => {
  it("only the Super Admin defines templates; customers create instances within field constraints", async () => {
    const ctx = await customerContext();
    const admin = await superAdminContext();
    const list = await api().get("/api/v1/templates").set(ctx.auth);
    expect(list.body.data[0].name).toBe("Flash Sale");
    expect(list.body.data[0].fields[0]).toMatchObject({ key: "headline", required: true, max: 10 });
    const templateId = list.body.data[0].id;

    const forbidden = await api().post("/api/v1/templates").set(ctx.auth).send({ name: "Mine", category: "Retail", fields: [{ key: "a", label: "A", type: "text" }] });
    expect(forbidden.status).toBe(403);
    const dupKeys = await api().post("/api/v1/templates").set(admin.auth).send({ name: "Dup", category: "Retail", fields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" }] });
    expect(dupKeys.body.error.code).toBe("DUPLICATE_FIELD");

    const tooLong = await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId, name: "Summer", values: { headline: "THIS IS WAY TOO LONG", accent: "red", extra: "x" } });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("TEMPLATE_VALUES_INVALID");
    expect(tooLong.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["accent", "extra", "headline"]);

    const missing = await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId, name: "Summer", values: {} });
    expect(missing.body.error.details[0].path).toBe("headline");

    const inst = await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId, name: "Summer", values: { headline: "50% OFF", accent: "#2563EB" } });
    expect(inst.status).toBe(201);
    expect(inst.body.data).toMatchObject({ templateName: "Flash Sale", rendered: false, outputUrl: null });

    const screen = await pairedScreen(ctx.auth);
    const early = await api().post(`/api/v1/template-instances/${inst.body.data.id}/publish`).set(ctx.auth).set("Idempotency-Key", "t1").send({ screenIds: [screen.id] });
    expect(early.body.error.code).toBe("NOT_RENDERED");

    expect((await api().post(`/api/v1/template-instances/${inst.body.data.id}/render`).set(ctx.auth)).status).toBe(202);
    await templateRender({ instanceId: inst.body.data.id, companyId: ctx.company.id });
    const rendered = await api().get(`/api/v1/template-instances/${inst.body.data.id}`).set(ctx.auth);
    expect(rendered.body.data.rendered).toBe(true);
    expect((await fetch(rendered.body.data.outputUrl)).status).toBe(200);

    const pub = await api().post(`/api/v1/template-instances/${inst.body.data.id}/publish`).set(ctx.auth).set("Idempotency-Key", "t2").send({ screenIds: [screen.id] });
    expect(pub.status).toBe(200);
    expect((await api().delete(`/api/v1/templates/${templateId}`).set(admin.auth)).body.error.code).toBe("TEMPLATE_IN_USE");
  });
});
