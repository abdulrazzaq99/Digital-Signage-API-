import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { customerContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

async function setup() {
  const ctx = await customerContext();
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 10)}` })).body.data;
  const screen = (await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "Lobby" })).body.data as { id: string };
  const asset = await prisma.mediaAsset.create({ data: { companyId: ctx.company.id, name: "a.jpg", type: "IMAGE", status: "READY", mimeType: "image/jpeg", sizeBytes: BigInt(1), storageKey: `${ctx.company.id}/a-${Math.random()}` } });
  const playlist = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Morning", items: [{ assetId: asset.id, durationSec: 5 }] })).body.data as { id: string };
  return { ctx, screen, playlist };
}

describe("schedule writes", () => {
  it("creates only one of several overlapping schedules sent at the same time", async () => {
    const { ctx, screen, playlist } = await setup();
    const startsAt = new Date(Date.now() + 3600_000).toISOString();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", `race-${i}`).send({ playlistId: playlist.id, targetKind: "SCREEN", targetId: screen.id, startsAt })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "SCHEDULE_CONFLICT")).toBe(true);
    expect(await prisma.schedule.count()).toBe(1);
  });

  it("refuses scheduling an empty playlist", async () => {
    const { ctx, screen, playlist } = await setup();
    const empty = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Empty" })).body.data;
    const startsAt = new Date(Date.now() + 3600_000).toISOString();
    const res = await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "e1").send({ playlistId: empty.id, targetKind: "SCREEN", targetId: screen.id, startsAt });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "PLAYLIST_EMPTY", details: [{ path: "body.playlistId" }] });

    const s = (await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "e2").send({ playlistId: playlist.id, targetKind: "SCREEN", targetId: screen.id, startsAt })).body.data;
    expect((await api().patch(`/api/v1/schedules/${s.id}`).set(ctx.auth).send({ playlistId: empty.id })).body.error.code).toBe("PLAYLIST_EMPTY");
  });

  it("checks conflicts on update against the other schedules of the target", async () => {
    const { ctx, screen, playlist } = await setup();
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "u1").send({ playlistId: playlist.id, targetKind: "SCREEN", targetId: screen.id, startsAt: at(1), endsAt: at(2) });
    const later = (await api().post("/api/v1/schedules").set(ctx.auth).set("Idempotency-Key", "u2").send({ playlistId: playlist.id, targetKind: "SCREEN", targetId: screen.id, startsAt: at(3), endsAt: at(4) })).body.data;
    const clash = await api().patch(`/api/v1/schedules/${later.id}`).set(ctx.auth).send({ startsAt: at(1.5) });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("SCHEDULE_CONFLICT");
    expect((await api().patch(`/api/v1/schedules/${later.id}`).set(ctx.auth).send({ startsAt: at(2.5) })).status).toBe(200);
  });
});
