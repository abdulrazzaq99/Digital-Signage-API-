import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { touchPresence } from "../../core/redis/presence.js";
import { templateRender } from "../../jobs/template.render.js";
import { customerContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

type Ctx = Awaited<ReturnType<typeof customerContext>>;

async function pairedScreen(auth: Record<string, string>, name = "Screen") {
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 8)}` })).body.data;
  const screen = (await api().post("/api/v1/screens/pair").set(auth).send({ code: session.code, name })).body.data as { id: string };
  const credential = (await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`)).body.data.credential as string;
  return { ...screen, credential };
}
const asset = (ctx: Ctx, name = "a.jpg") => prisma.mediaAsset.create({ data: { companyId: ctx.company.id, name, type: "IMAGE", status: "READY", mimeType: "image/jpeg", sizeBytes: BigInt(100), checksum: `sum-${name}`, storageKey: `${ctx.company.id}/${name}-${Math.random()}` } });
const playlist = async (ctx: Ctx, name: string, assetIds: string[]) => (await api().post("/api/v1/playlists").set(ctx.auth).send({ name, items: assetIds.map((assetId) => ({ assetId, durationSec: 10 })) })).body.data as { id: string; items: { id: string }[] };
const manifest = async (credential: string) => (await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${credential}`)).body.data;
const version = async (screenId: string) => (await prisma.screen.findUniqueOrThrow({ where: { id: screenId } })).manifestVersion;
let key = 0;
const publish = (ctx: Ctx, path: string, screenIds: string[]) => api().post(path).set(ctx.auth).set("Idempotency-Key", `k${++key}`).send({ screenIds });

describe("manifest content (B3)", () => {
  it("carries the items and files of a future schedule, even with no assignment", async () => {
    const ctx = await customerContext();
    const screen = await pairedScreen(ctx.auth);
    const group = (await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Lobby", screenIds: [screen.id] })).body.data;
    const a = await asset(ctx, "promo.jpg");
    const p = await playlist(ctx, "Weekend Promo", [a.id]);
    const startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect((await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s1").send({ playlistId: p.id, targetKind: "GROUP", targetId: group.id, startsAt })).status).toBe(201);

    const m = await manifest(screen.credential);
    expect(m.assignment).toBeNull();
    expect(m.schedule).toEqual([expect.objectContaining({ playlistId: p.id, name: "Weekend Promo", targetKind: "GROUP", startsAt, items: [{ assetId: a.id, position: 0, durationSec: 10 }] })]);
    expect(m.assets).toEqual([expect.objectContaining({ id: a.id, checksum: "sum-promo.jpg", sizeBytes: 100, url: expect.stringContaining("X-Amz-Signature") })]);
  });

  it("lists each file once across the assignment and schedules", async () => {
    const ctx = await customerContext();
    const screen = await pairedScreen(ctx.auth);
    const shared = await asset(ctx, "shared.jpg");
    const only = await asset(ctx, "only.jpg");
    const main = await playlist(ctx, "Main", [shared.id, shared.id]);
    const later = await playlist(ctx, "Later", [shared.id, only.id]);
    await publish(ctx, `/api/v1/playlists/${main.id}/publish`, [screen.id]);
    await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s2").send({ playlistId: later.id, targetKind: "SCREEN", targetId: screen.id, startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    const m = await manifest(screen.credential);
    expect(m.items.map((i: { assetId: string }) => i.assetId)).toEqual([shared.id, shared.id]);
    expect(m.assets.map((x: { id: string }) => x.id).sort()).toEqual([shared.id, only.id].sort());
  });
});

describe("live on save (B4)", () => {
  it("bumps the version of every screen showing a playlist when it is edited", async () => {
    const ctx = await customerContext();
    const direct = await pairedScreen(ctx.auth, "Direct");
    const viaGroup = await pairedScreen(ctx.auth, "Scheduled");
    const bystander = await pairedScreen(ctx.auth, "Other");
    const group = (await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Kitchen", screenIds: [viaGroup.id] })).body.data;
    const a = await asset(ctx, "one.jpg");
    const b = await asset(ctx, "two.jpg");
    const p = await playlist(ctx, "Menu", [a.id]);
    const other = await playlist(ctx, "Unrelated", [a.id]);
    await publish(ctx, `/api/v1/playlists/${p.id}/publish`, [direct.id]);
    await publish(ctx, `/api/v1/playlists/${other.id}/publish`, [bystander.id]);
    await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s3").send({ playlistId: p.id, targetKind: "GROUP", targetId: group.id, startsAt: new Date().toISOString() });
    const v = { direct: await version(direct.id), group: await version(viaGroup.id), bystander: await version(bystander.id) };
    const before = await manifest(direct.credential);

    const added = await api().post(`/api/v1/playlists/${p.id}/items`).set(ctx.auth).send({ assetId: b.id, durationSec: 5 });
    expect(added.status).toBe(201);
    expect(await version(direct.id)).toBe(v.direct + 1);
    expect(await version(viaGroup.id)).toBe(v.group + 1);
    expect(await version(bystander.id)).toBe(v.bystander);
    const after = await manifest(direct.credential);
    expect(after.version).toBe(before.version + 1);
    expect(after.items).toHaveLength(2);

    const items = added.body.data.items as { id: string }[];
    await api().put(`/api/v1/playlists/${p.id}/reorder`).set(ctx.auth).send({ itemIds: [items[1]!.id, items[0]!.id] });
    await api().patch(`/api/v1/playlists/${p.id}/items/${items[0]!.id}`).set(ctx.auth).send({ durationSec: 20 });
    await api().delete(`/api/v1/playlists/${p.id}/items/${items[1]!.id}`).set(ctx.auth);
    await api().patch(`/api/v1/playlists/${p.id}`).set(ctx.auth).send({ name: "Lunch Menu" });
    expect(await version(direct.id)).toBe(v.direct + 5);
    expect((await manifest(direct.credential)).assignment.name).toBe("Lunch Menu");
    expect(await version(bystander.id)).toBe(v.bystander);
  });

  it("bumps screens when media they play is force-deleted", async () => {
    const ctx = await customerContext();
    const screen = await pairedScreen(ctx.auth);
    const a = await asset(ctx, "keep.jpg");
    const gone = await asset(ctx, "gone.jpg");
    const p = await playlist(ctx, "P", [a.id, gone.id]);
    await publish(ctx, `/api/v1/playlists/${p.id}/publish`, [screen.id]);
    const v = await version(screen.id);
    expect((await api().delete(`/api/v1/media/${gone.id}?force=true`).set(ctx.auth)).status).toBe(204);
    expect(await version(screen.id)).toBe(v + 1);
    expect((await manifest(screen.credential)).items).toHaveLength(1);
  });

  it("bumps screens when a live layout zone is rebound", async () => {
    const ctx = await customerContext();
    await prisma.layout.create({ data: { presetId: "full", name: "Full", isPreset: true, zones: { create: [{ index: 0, name: "Main", x: 0, y: 0, w: 1, h: 1 }] } } });
    const screen = await pairedScreen(ctx.auth);
    const a = await asset(ctx, "l1.jpg");
    const b = await asset(ctx, "l2.jpg");
    const layout = (await api().post("/api/v1/layouts").set(ctx.auth).send({ presetId: "full", name: "Lobby" })).body.data;
    await api().put(`/api/v1/layouts/${layout.id}/zones/0`).set(ctx.auth).send({ bindingKind: "MEDIA", refId: a.id });
    await publish(ctx, `/api/v1/layouts/${layout.id}/publish`, [screen.id]);
    const v = await version(screen.id);
    await api().put(`/api/v1/layouts/${layout.id}/zones/0`).set(ctx.auth).send({ bindingKind: "MEDIA", refId: b.id });
    expect(await version(screen.id)).toBe(v + 1);
    const m = await manifest(screen.credential);
    expect(m.layout.zones[0].items).toEqual([{ assetId: b.id, position: 0, durationSec: 10 }]);
    expect(m.assets.map((x: { id: string }) => x.id)).toEqual([b.id]);
  });

  it("bumps the target when a schedule is created, changed or removed", async () => {
    const ctx = await customerContext();
    const screen = await pairedScreen(ctx.auth);
    const p = await playlist(ctx, "P", [(await asset(ctx)).id]);
    const q = await playlist(ctx, "Q", [(await asset(ctx, "q.jpg")).id]);
    const v = await version(screen.id);
    const s = (await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s4").send({ playlistId: p.id, targetKind: "SCREEN", targetId: screen.id, startsAt: new Date().toISOString() })).body.data;
    expect(await version(screen.id)).toBe(v + 1);
    await api().patch(`/api/v1/schedules/${s.id}`).set(ctx.auth).send({ playlistId: q.id });
    expect(await version(screen.id)).toBe(v + 2);
    expect((await manifest(screen.credential)).schedule[0].playlistId).toBe(q.id);
    await api().delete(`/api/v1/schedules/${s.id}`).set(ctx.auth);
    expect(await version(screen.id)).toBe(v + 3);
    expect((await manifest(screen.credential)).schedule).toEqual([]);
  });

  it("keeps a live template's output until the re-render lands, then bumps", async () => {
    const ctx = await customerContext();
    const t = await prisma.template.create({ data: { name: "Sale", category: "Retail", isGlobal: true, fields: [{ key: "headline", label: "Headline", type: "text", required: true }] } });
    const screen = await pairedScreen(ctx.auth);
    const inst = (await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId: t.id, name: "Sale", values: { headline: "10% off" } })).body.data;
    await templateRender({ instanceId: inst.id, companyId: ctx.company.id });
    await publish(ctx, `/api/v1/template-instances/${inst.id}/publish`, [screen.id]);
    const v = await version(screen.id);
    const first = await manifest(screen.credential);
    expect(first.items).toEqual([{ assetId: inst.id, position: 0, durationSec: 15 }]);

    expect((await api().patch(`/api/v1/template-instances/${inst.id}`).set(ctx.auth).send({ values: { headline: "20% off" } })).status).toBe(200);
    // Same version, same content: the old output is still served while the render is queued.
    const during = await manifest(screen.credential);
    expect(during.version).toBe(v);
    expect(during.assets[0].checksum).toBe(first.assets[0].checksum);

    await templateRender({ instanceId: inst.id, companyId: ctx.company.id });
    const after = await manifest(screen.credential);
    expect(after.version).toBe(v + 1);
    expect(after.assets[0].checksum).not.toBe(first.assets[0].checksum);
    expect((await fetch(after.assets[0].url)).status).toBe(200);
  });
});

describe("canvas manifest (B2)", () => {
  it("gives each member its content, slot and viewport, and tracks preload readiness", async () => {
    const ctx = await customerContext();
    const left = await pairedScreen(ctx.auth, "Left");
    const right = await pairedScreen(ctx.auth, "Right");
    const a = await asset(ctx, "wide.jpg");
    const p = await playlist(ctx, "Wide", [a.id]);
    const canvas = (await api().post("/api/v1/canvas").set(ctx.auth).send({ name: "Wall", screenIds: [left.id, right.id] })).body.data;
    await api().patch(`/api/v1/canvas/${canvas.id}`).set(ctx.auth).send({ content: { kind: "PLAYLIST", refId: p.id } });
    await touchPresence(left.id);
    await touchPresence(right.id);
    const active = (await api().post(`/api/v1/canvas/${canvas.id}/activate`).set(ctx.auth).set("Idempotency-Key", "c1")).body.data;
    expect(active.members.map((m: { ready: boolean; online: boolean }) => [m.online, m.ready])).toEqual([[true, false], [true, false]]);

    // A player that connects after activation still gets everything it needs.
    const m = await manifest(right.credential);
    expect(m.assignment).toMatchObject({ kind: "CANVAS", refId: canvas.id, name: "Wall" });
    expect(m.items).toEqual([{ assetId: a.id, position: 0, durationSec: 10 }]);
    expect(m.assets.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(m.canvas).toEqual({ setId: canvas.id, position: 1, total: 2, activateAt: active.activateAt, viewport: { x: 0.5, y: 0, width: 0.5, height: 1 }, content: { kind: "PLAYLIST", refId: p.id } });
    expect(m.activateAt).toBe(active.activateAt);

    await api().post("/api/v1/player/sync-ack").set("Authorization", `Bearer ${right.credential}`).send({ version: m.version, status: "downloaded" });
    const partly = (await api().get(`/api/v1/canvas/${canvas.id}`).set(ctx.auth)).body.data;
    expect(partly.members.map((x: { preloaded: boolean }) => x.preloaded)).toEqual([false, true]);
    expect(partly.readyCount).toBe(1);

    // Editing the canvas content's playlist goes live on every member.
    const v = await version(left.id);
    await api().post(`/api/v1/playlists/${p.id}/items`).set(ctx.auth).send({ assetId: (await asset(ctx, "more.jpg")).id });
    expect(await version(left.id)).toBe(v + 1);
    expect((await api().get(`/api/v1/canvas/${canvas.id}`).set(ctx.auth)).body.data.readyCount).toBe(0);

    await api().post(`/api/v1/canvas/${canvas.id}/deactivate`).set(ctx.auth);
    expect(await version(left.id)).toBe(v + 2);
    const off = await manifest(left.credential);
    expect(off.assignment).toBeNull();
    expect(off.canvas).toBeNull();
  });
});
