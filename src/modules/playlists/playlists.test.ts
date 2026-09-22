import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { customerContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

async function readyAsset(companyId: string, name = "a.jpg", type: "IMAGE" | "VIDEO" | "PDF" = "IMAGE") {
  return prisma.mediaAsset.create({ data: { companyId, name, type, status: "READY", mimeType: type === "IMAGE" ? "image/jpeg" : type === "VIDEO" ? "video/mp4" : "application/pdf", sizeBytes: BigInt(100), storageKey: `${companyId}/${name}-${Math.random()}` } });
}

async function pairedScreen(auth: Record<string, string>, name = "Screen") {
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 8)}` })).body.data;
  return (await api().post("/api/v1/screens/pair").set(auth).send({ code: session.code, name })).body.data as { id: string };
}

describe("playlists", () => {
  it("creates with items, applies default durations by type, and lists with counts", async () => {
    const ctx = await customerContext();
    const img = await readyAsset(ctx.company.id, "img.jpg");
    const vid = await readyAsset(ctx.company.id, "clip.mp4", "VIDEO");
    const res = await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Summer Offers", items: [{ assetId: img.id, durationSec: 15 }, { assetId: vid.id, durationSec: 45 }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Summer Offers", status: "DRAFT", itemCount: 2, totalDurationSec: 60 });
    expect(res.body.data.items[0].asset.thumbnailUrl).toContain("X-Amz-Signature");
    const add = await api().post(`/api/v1/playlists/${res.body.data.id}/items`).set(ctx.auth).send({ assetId: vid.id });
    expect(add.body.data.items[2].durationSec).toBe(30);
    const list = await api().get("/api/v1/playlists").set(ctx.auth);
    expect(list.body.data[0]).toMatchObject({ itemCount: 3, assignedTo: [] });
  });

  it("rejects items that are not ready or belong to another company", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const foreign = await readyAsset(other.company.id);
    const notReady = await prisma.mediaAsset.create({ data: { companyId: ctx.company.id, name: "p.mp4", type: "VIDEO", status: "PROCESSING", mimeType: "video/mp4", sizeBytes: BigInt(1), storageKey: "x/p" } });
    for (const assetId of [foreign.id, notReady.id]) {
      const res = await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Bad", items: [{ assetId, durationSec: 10 }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("ASSET_NOT_FOUND");
    }
  });

  it("reorders only with a full permutation and edits item durations", async () => {
    const ctx = await customerContext();
    const a = await readyAsset(ctx.company.id, "a");
    const b = await readyAsset(ctx.company.id, "b");
    const p = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "P", items: [{ assetId: a.id, durationSec: 5 }, { assetId: b.id, durationSec: 6 }] })).body.data;
    const [i1, i2] = p.items.map((i: { id: string }) => i.id);
    const bad = await api().put(`/api/v1/playlists/${p.id}/reorder`).set(ctx.auth).send({ itemIds: [i1] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_ORDER");
    const ok = await api().put(`/api/v1/playlists/${p.id}/reorder`).set(ctx.auth).send({ itemIds: [i2, i1] });
    expect(ok.body.data.items.map((i: { asset: { name: string } }) => i.asset.name)).toEqual(["b", "a"]);
    expect(ok.body.data.items.map((i: { id: string }) => i.id)).toEqual([i2, i1]);
    const dur = await api().patch(`/api/v1/playlists/${p.id}/items/${ok.body.data.items[0].id}`).set(ctx.auth).send({ durationSec: 20 });
    expect(dur.body.data.totalDurationSec).toBe(25);
    const del = await api().delete(`/api/v1/playlists/${p.id}/items/${ok.body.data.items[0].id}`).set(ctx.auth);
    expect(del.body.data.itemCount).toBe(1);
  });

  it("duplicates and refuses to delete while assigned", async () => {
    const ctx = await customerContext();
    const a = await readyAsset(ctx.company.id);
    const screen = await pairedScreen(ctx.auth);
    const p = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Live", items: [{ assetId: a.id, durationSec: 5 }] })).body.data;
    const copy = await api().post(`/api/v1/playlists/${p.id}/duplicate`).set(ctx.auth);
    expect(copy.status).toBe(201);
    expect(copy.body.data).toMatchObject({ name: "Live (copy)", status: "DRAFT", itemCount: 1 });
    await api().post(`/api/v1/playlists/${p.id}/publish`).set(ctx.auth).set("Idempotency-Key", "k1").send({ screenIds: [screen.id] });
    const del = await api().delete(`/api/v1/playlists/${p.id}`).set(ctx.auth);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("PLAYLIST_IN_USE");
  });
});

describe("publish", () => {
  it("publishes to screens and groups, bumps manifest versions, upserts assignments, and is idempotent", async () => {
    const ctx = await customerContext({ screenLimit: 5 });
    const a = await readyAsset(ctx.company.id);
    const s1 = await pairedScreen(ctx.auth, "S1");
    const s2 = await pairedScreen(ctx.auth, "S2");
    const s3 = await pairedScreen(ctx.auth, "S3");
    const group = (await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Group", screenIds: [s2.id, s3.id] })).body.data;
    const p = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "P", items: [{ assetId: a.id, durationSec: 5 }] })).body.data;

    const missing = await api().post(`/api/v1/playlists/${p.id}/publish`).set(ctx.auth).send({ screenIds: [s1.id] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const first = await api().post(`/api/v1/playlists/${p.id}/publish`).set(ctx.auth).set("Idempotency-Key", "pub-1").send({ screenIds: [s1.id], groupIds: [group.id] });
    expect(first.status).toBe(200);
    expect(first.body.data.screens).toHaveLength(3);
    expect(first.body.data.screens.every((s: { version: number }) => s.version === 1)).toBe(true);
    expect(await prisma.screenAssignment.count({ where: { refId: p.id } })).toBe(3);
    expect((await prisma.screen.findUnique({ where: { id: s1.id } }))).toMatchObject({ manifestVersion: 1, syncState: "PENDING" });
    expect((await prisma.playlist.findUnique({ where: { id: p.id } }))).toMatchObject({ status: "PUBLISHED", version: 1 });

    const replay = await api().post(`/api/v1/playlists/${p.id}/publish`).set(ctx.auth).set("Idempotency-Key", "pub-1").send({ screenIds: [s1.id], groupIds: [group.id] });
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect((await prisma.screen.findUnique({ where: { id: s1.id } }))?.manifestVersion).toBe(1);

    const again = await api().post(`/api/v1/playlists/${p.id}/publish`).set(ctx.auth).set("Idempotency-Key", "pub-2").send({ screenIds: [s1.id] });
    expect((await prisma.screen.findUnique({ where: { id: s1.id } }))?.manifestVersion).toBe(2);
    expect(again.body.data.version).toBe(2);
    const detail = await api().get(`/api/v1/playlists/${p.id}`).set(ctx.auth);
    expect(detail.body.data.assignedTo).toHaveLength(3);

    const screen = await api().get(`/api/v1/screens/${s1.id}`).set(ctx.auth);
    expect(screen.body.data.assignment).toMatchObject({ kind: "PLAYLIST", refId: p.id, version: 2, name: "P" });
    expect(screen.body.data.assignment).toHaveProperty("thumbnailUrl");
    const list = await api().get("/api/v1/screens").set(ctx.auth);
    expect(list.body.data.find((s: { id: string }) => s.id === s2.id).assignment.name).toBe("P");
  });

  it("blocks publishing with a suspended licence, empty playlists, and foreign screens", async () => {
    const ctx = await customerContext();
    const a = await readyAsset(ctx.company.id);
    const screen = await pairedScreen(ctx.auth);
    const empty = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Empty" })).body.data;
    const e = await api().post(`/api/v1/playlists/${empty.id}/publish`).set(ctx.auth).set("Idempotency-Key", "e").send({ screenIds: [screen.id] });
    expect(e.body.error.code).toBe("PLAYLIST_EMPTY");
    const p = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "P", items: [{ assetId: a.id, durationSec: 5 }] })).body.data;
    const other = await customerContext();
    const foreign = await pairedScreen(other.auth);
    const f = await api().post(`/api/v1/playlists/${p.id}/publish`).set(ctx.auth).set("Idempotency-Key", "f").send({ screenIds: [foreign.id] });
    expect(f.status).toBe(400);
    expect(f.body.error.code).toBe("SCREEN_NOT_FOUND");
    await prisma.license.update({ where: { companyId: ctx.company.id }, data: { state: "SUSPENDED" } });
    const s = await api().post(`/api/v1/playlists/${p.id}/publish`).set(ctx.auth).set("Idempotency-Key", "s").send({ screenIds: [screen.id] });
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe("LICENSE_SUSPENDED");
  });
});

describe("schedules", () => {
  it("validates windows, detects conflicts, and resolves the active assignment by precedence", async () => {
    const ctx = await customerContext({ screenLimit: 3 });
    const a = await readyAsset(ctx.company.id);
    const screen = await pairedScreen(ctx.auth);
    const group = (await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Group", screenIds: [screen.id] })).body.data;
    const p1 = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Morning", items: [{ assetId: a.id, durationSec: 5 }] })).body.data;
    const p2 = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Default", items: [{ assetId: a.id, durationSec: 5 }] })).body.data;
    await api().post(`/api/v1/playlists/${p2.id}/publish`).set(ctx.auth).set("Idempotency-Key", "d").send({ screenIds: [screen.id] });

    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const bad = await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s0").send({ playlistId: p1.id, targetKind: "SCREEN", targetId: screen.id, startsAt: future, endsAt: past });
    expect(bad.status).toBe(400);

    const groupSched = await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s1").send({ playlistId: p1.id, targetKind: "GROUP", targetId: group.id, startsAt: past, endsAt: future, timezone: "Europe/London" });
    expect(groupSched.status).toBe(201);
    expect(groupSched.body.data).toMatchObject({ status: "ACTIVE", targetName: "Group", timezone: "Europe/London" });

    const conflict = await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s2").send({ playlistId: p2.id, targetKind: "GROUP", targetId: group.id, startsAt: new Date().toISOString(), endsAt: null });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("SCHEDULE_CONFLICT");
    expect(conflict.body.error.details.conflicts[0].scheduleId).toBe(groupSched.body.data.id);

    const active1 = await api().get(`/api/v1/schedules/active?screenId=${screen.id}`).set(ctx.auth);
    expect(active1.body.data).toMatchObject({ source: "SCHEDULE_GROUP", playlistId: p1.id });

    const screenSched = await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s3").send({ playlistId: p2.id, targetKind: "SCREEN", targetId: screen.id, startsAt: past, endsAt: future });
    expect(screenSched.status).toBe(201);
    const active2 = await api().get(`/api/v1/schedules/active?screenId=${screen.id}`).set(ctx.auth);
    expect(active2.body.data).toMatchObject({ source: "SCHEDULE_SCREEN", playlistId: p2.id });

    const later = new Date(Date.now() + 7200_000).toISOString();
    const active3 = await api().get(`/api/v1/schedules/active?screenId=${screen.id}&at=${encodeURIComponent(later)}`).set(ctx.auth);
    expect(active3.body.data).toMatchObject({ source: "ASSIGNMENT", assignment: { kind: "PLAYLIST", refId: p2.id } });

    expect((await api().delete(`/api/v1/schedules/${screenSched.body.data.id}`).set(ctx.auth)).status).toBe(204);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const dayAfter = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect((await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "s4").send({ playlistId: p2.id, targetKind: "SCREEN", targetId: screen.id, startsAt: tomorrow, endsAt: dayAfter })).status).toBe(201);
    const list = await api().get("/api/v1/schedules?activeOnly=true").set(ctx.auth);
    expect(list.body.data).toHaveLength(1);
    const all = await api().get("/api/v1/schedules?activeOnly=false").set(ctx.auth);
    expect(all.body.data).toHaveLength(2);
  });

  it("rejects a PATCH that points a schedule at another company's playlist", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const a = await readyAsset(ctx.company.id);
    const screen = await pairedScreen(ctx.auth);
    const mine = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Mine", items: [{ assetId: a.id, durationSec: 5 }] })).body.data;
    const otherAsset = await readyAsset(other.company.id);
    const theirs = (await api().post("/api/v1/playlists").set(other.auth).send({ name: "Theirs", items: [{ assetId: otherAsset.id, durationSec: 5 }] })).body.data;
    const start = new Date(Date.now() + 3600_000).toISOString();
    const sched = (await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "x1").send({ playlistId: mine.id, targetKind: "SCREEN", targetId: screen.id, startsAt: start })).body.data;
    const res = await api().patch(`/api/v1/schedules/${sched.id}`).set(ctx.auth).send({ playlistId: theirs.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PLAYLIST_NOT_FOUND");
    expect((await prisma.schedule.findUnique({ where: { id: sched.id } }))?.playlistId).toBe(mine.id);
  });
});
