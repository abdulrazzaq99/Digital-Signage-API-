import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import { getQueue, JobNames } from "../queue/queues.js";
import { headObject, putObject } from "../storage/s3.js";
import { companyPurge } from "../../jobs/company.purge.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

async function pairedScreen(auth: Record<string, string>, name: string) {
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 10)}` })).body.data;
  return (await api().post("/api/v1/screens/pair").set(auth).send({ code: session.code, name })).body.data as { id: string };
}

const image = (companyId: string) =>
  prisma.mediaAsset.create({ data: { companyId, name: "a.jpg", type: "IMAGE", status: "READY", mimeType: "image/jpeg", sizeBytes: BigInt(1), storageKey: `${companyId}/a-${Math.random()}` } });

async function canvasShowing(ctx: Awaited<ReturnType<typeof customerContext>>, kind: string, refId: string) {
  const a = await pairedScreen(ctx.auth, "Left");
  const b = await pairedScreen(ctx.auth, "Right");
  const canvas = (await api().post("/api/v1/canvas").set(ctx.auth).send({ name: "Wall", screenIds: [a.id, b.id] })).body.data;
  expect((await api().patch(`/api/v1/canvas/${canvas.id}`).set(ctx.auth).send({ content: { kind, refId } })).status).toBe(200);
  return canvas as { id: string };
}

describe("deletes that would orphan content", () => {
  it("refuses deleting a playlist a canvas or layout zone shows", async () => {
    const ctx = await customerContext();
    const asset = await image(ctx.company.id);
    const p = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Wide", items: [{ assetId: asset.id, durationSec: 5 }] })).body.data;
    const canvas = await canvasShowing(ctx, "PLAYLIST", p.id);
    const res = await api().delete(`/api/v1/playlists/${p.id}`).set(ctx.auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "IN_USE", details: { canvases: [{ id: canvas.id, name: "Wall" }], layouts: [] } });

    await api().patch(`/api/v1/canvas/${canvas.id}`).set(ctx.auth).send({ content: null });
    const preset = await prisma.layout.create({ data: { presetId: "p-full", name: "Full", isPreset: true, zones: { create: [{ index: 0, name: "Main", x: 0, y: 0, w: 1, h: 1 }] } } });
    const layout = (await api().post("/api/v1/layouts").set(ctx.auth).send({ presetId: preset.presetId, name: "Lobby" })).body.data;
    await api().put(`/api/v1/layouts/${layout.id}/zones/0`).set(ctx.auth).send({ bindingKind: "PLAYLIST", refId: p.id });
    const zoned = await api().delete(`/api/v1/playlists/${p.id}`).set(ctx.auth);
    expect(zoned.body.error).toMatchObject({ code: "IN_USE", details: { layouts: [{ id: layout.id, name: "Lobby" }] } });
  });

  it("refuses deleting a playlist with current or upcoming schedules, but not with past ones", async () => {
    const ctx = await customerContext();
    const screen = await pairedScreen(ctx.auth, "Lobby");
    const asset = await image(ctx.company.id);
    const p = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Morning", items: [{ assetId: asset.id, durationSec: 5 }] })).body.data;
    const past = await prisma.schedule.create({ data: { companyId: ctx.company.id, playlistId: p.id, targetKind: "SCREEN", targetId: screen.id, startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 3600_000) } });
    const upcoming = await prisma.schedule.create({ data: { companyId: ctx.company.id, playlistId: p.id, targetKind: "SCREEN", targetId: screen.id, startsAt: new Date(Date.now() + 3600_000) } });
    const res = await api().delete(`/api/v1/playlists/${p.id}`).set(ctx.auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "PLAYLIST_SCHEDULED", details: { schedules: [{ id: upcoming.id }] } });
    await prisma.schedule.delete({ where: { id: upcoming.id } });
    expect((await api().delete(`/api/v1/playlists/${p.id}`).set(ctx.auth)).status).toBe(204);
    expect(await prisma.schedule.count({ where: { id: past.id } })).toBe(0);
  });

  it("refuses deleting a layout or template instance a canvas shows", async () => {
    const ctx = await customerContext({ screenLimit: 5 });
    const preset = await prisma.layout.create({ data: { presetId: "p-full", name: "Full", isPreset: true, zones: { create: [{ index: 0, name: "Main", x: 0, y: 0, w: 1, h: 1 }] } } });
    const layout = (await api().post("/api/v1/layouts").set(ctx.auth).send({ presetId: preset.presetId, name: "Lobby" })).body.data;
    const canvas = await canvasShowing(ctx, "LAYOUT", layout.id);
    const res = await api().delete(`/api/v1/layouts/${layout.id}`).set(ctx.auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "IN_USE", details: { canvases: [{ id: canvas.id }] } });

    const template = await prisma.template.create({ data: { name: "Promo", category: "Retail", fields: [{ key: "headline", label: "Headline", type: "text" }] } });
    const instance = await prisma.templateInstance.create({ data: { companyId: ctx.company.id, templateId: template.id, name: "Spring", values: { headline: "Hi" } } });
    await api().patch(`/api/v1/canvas/${canvas.id}`).set(ctx.auth).send({ content: { kind: "TEMPLATE_INSTANCE", refId: instance.id } });
    expect((await api().delete(`/api/v1/template-instances/${instance.id}`).set(ctx.auth)).body.error.code).toBe("IN_USE");
    expect((await api().delete(`/api/v1/layouts/${layout.id}`).set(ctx.auth)).status).toBe(204);
  });

  it("refuses deleting a company with paired screens, and purges its storage after a delete", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const screen = await pairedScreen(ctx.auth, "Lobby");
    const blocked = await api().delete(`/api/v1/companies/${ctx.company.id}`).set(admin.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: "COMPANY_HAS_SCREENS", details: { screens: 1 } });

    await api().post(`/api/v1/screens/${screen.id}/unpair`).set(ctx.auth);
    const key = `${ctx.company.id}/abc/file.png`;
    await putObject(key, Buffer.from("x"), "image/png");
    expect((await api().delete(`/api/v1/companies/${ctx.company.id}`).set(admin.auth)).status).toBe(204);
    const jobs = await getQueue().getJobs(["waiting", "delayed", "prioritized"]);
    expect(jobs.some((j) => j.name === JobNames.companyPurge && j.data.companyId === ctx.company.id)).toBe(true);

    expect(await companyPurge({ companyId: ctx.company.id })).toEqual({ deleted: 1 });
    expect(await headObject(key)).toBeNull();
    await expect(companyPurge({ companyId: "" })).rejects.toThrow(/Refusing/);
  });
});
