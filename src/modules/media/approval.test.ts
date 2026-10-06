import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** Uploads and finalizes a 1x1 PNG; returns the media as the API reports it. */
async function uploadImage(auth: Record<string, string>, fileName = "pixel.png") {
  const res = await api().post("/api/v1/media/upload-url").set(auth).send({ fileName, contentType: "image/png", sizeBytes: PNG.length });
  expect(res.status).toBe(201);
  expect((await fetch(res.body.data.uploadUrl, { method: "PUT", body: PNG, headers: { "Content-Type": "image/png" } })).status).toBe(200);
  const fin = await api().post(`/api/v1/media/${res.body.data.asset.id}/finalize`).set(auth).send({ width: 1, height: 1 });
  expect(fin.status).toBe(200);
  return fin.body.data as { id: string; approval: string };
}

/** Pairs a screen, publishes a playlist of the given files to it, and returns a manifest reader. */
async function screenPlaying(ctx: Awaited<ReturnType<typeof customerContext>>, assetIds: string[]) {
  const playlist = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Lobby", items: assetIds.map((assetId) => ({ assetId, durationSec: 10 })) })).body.data;
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 10)}` })).body.data;
  const screen = (await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "Lobby" })).body.data;
  const credential = (await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`)).body.data.credential;
  expect((await api().post(`/api/v1/playlists/${playlist.id}/publish`).set(ctx.auth).set("Idempotency-Key", `pub-${playlist.id}`).send({ screenIds: [screen.id] })).status).toBe(200);
  return async () => (await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${credential}`)).body.data as { version: number; items: { assetId: string }[] };
}

describe("media approval", () => {
  it("holds company uploads for approval, but not the Super Admin's or a company switched off", async () => {
    const ctx = await customerContext();
    const admin = await superAdminContext();
    expect(await uploadImage(ctx.auth)).toMatchObject({ approval: "PENDING", rejectionReason: null, reviewedAt: null, company: { id: ctx.company.id } });
    expect(await uploadImage({ ...admin.auth, "x-company-id": ctx.company.id })).toMatchObject({ approval: "APPROVED" });

    // Only the Super Admin may switch approval off for a company.
    const self = await api().patch(`/api/v1/companies/${ctx.company.id}`).set(ctx.auth).send({ mediaApproval: false });
    expect(self.status).toBe(403);
    const off = await api().patch(`/api/v1/companies/${ctx.company.id}`).set(admin.auth).send({ mediaApproval: false });
    expect(off.body.data.mediaApproval).toBe(false);
    expect(await uploadImage(ctx.auth)).toMatchObject({ approval: "APPROVED" });
  });

  it("lists files waiting for approval across companies, leaving out unfinished uploads", async () => {
    const a = await customerContext();
    const b = await customerContext();
    const admin = await superAdminContext();
    const waiting = await uploadImage(a.auth, "a.png");
    await uploadImage(b.auth, "b.png");
    await api().post("/api/v1/media/upload-url").set(a.auth).send({ fileName: "never-sent.png", contentType: "image/png", sizeBytes: PNG.length });

    const all = await api().get("/api/v1/media?approval=PENDING").set(admin.auth);
    expect(all.body.data.map((m: { name: string }) => m.name).sort()).toEqual(["a.png", "b.png"]);
    expect(all.body.data.find((m: { id: string }) => m.id === waiting.id).company).toEqual({ id: a.company.id, name: a.company.name });
    const own = await api().get("/api/v1/media?approval=PENDING").set(a.auth);
    expect(own.body.data.map((m: { name: string }) => m.name)).toEqual(["a.png"]);
    expect(own.body.meta.stats).toMatchObject({ pending: 1, rejected: 0 });
  });

  it("only lets the Super Admin review, needs a reason to reject, and refuses repeats", async () => {
    const ctx = await customerContext();
    const admin = await superAdminContext();
    const m = await uploadImage(ctx.auth);
    expect((await api().post(`/api/v1/media/${m.id}/approve`).set(ctx.auth)).status).toBe(403);
    expect((await api().post(`/api/v1/media/${m.id}/reject`).set(admin.auth).send({ reason: "" })).status).toBe(400);
    expect((await api().post(`/api/v1/media/${m.id}/reject`).set(admin.auth).send({})).status).toBe(400);
    expect((await api().post(`/api/v1/media/${m.id}/approve`).set(admin.auth)).body.data).toMatchObject({ approval: "APPROVED", reviewedBy: admin.user.name });
    const again = await api().post(`/api/v1/media/${m.id}/approve`).set(admin.auth);
    expect([again.status, again.body.error.code]).toEqual([409, "ALREADY_REVIEWED"]);

    // A file still processing can be rejected but not approved.
    const pdf = await api().post("/api/v1/media/upload-url").set(ctx.auth).send({ fileName: "menu.pdf", contentType: "application/pdf", sizeBytes: 100 });
    const early = await api().post(`/api/v1/media/${pdf.body.data.asset.id}/approve`).set(admin.auth);
    expect([early.status, early.body.error.code]).toEqual([409, "MEDIA_NOT_READY"]);
  });

  it("keeps waiting files off screens, adds them on approval, and pulls them on rejection", async () => {
    const ctx = await customerContext();
    const admin = await superAdminContext();
    const ok = await uploadImage(ctx.auth, "ok.png");
    await api().post(`/api/v1/media/${ok.id}/approve`).set(admin.auth);
    const waiting = await uploadImage(ctx.auth, "waiting.png");
    const manifest = await screenPlaying(ctx, [ok.id, waiting.id]);

    const before = await manifest();
    expect(before.items.map((i) => i.assetId)).toEqual([ok.id]);

    await api().post(`/api/v1/media/${waiting.id}/approve`).set(admin.auth);
    const approved = await manifest();
    expect(approved.version).toBeGreaterThan(before.version);
    expect(approved.items.map((i) => i.assetId)).toEqual([ok.id, waiting.id]);

    const rejected = await api().post(`/api/v1/media/${waiting.id}/reject`).set(admin.auth).send({ reason: "The logo is the old one" });
    expect(rejected.body.data).toMatchObject({ approval: "REJECTED", rejectionReason: "The logo is the old one" });
    const after = await manifest();
    expect(after.version).toBeGreaterThan(approved.version);
    expect(after.items.map((i) => i.assetId)).toEqual([ok.id]);
  });

  it("tells the uploader in the portal", async () => {
    const ctx = await customerContext();
    const admin = await superAdminContext();
    const m = await uploadImage(ctx.auth, "menu.png");
    await api().post(`/api/v1/media/${m.id}/reject`).set(admin.auth).send({ reason: "Prices are missing" });
    const notes = await prisma.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: "Not approved: menu.png", audience: { kind: "users", userIds: [ctx.user.id] }, deepLink: "/portal/media" });
    expect(notes[0]!.body).toContain("Prices are missing");
    const activity = await prisma.activityLog.findFirst({ where: { action: "media.rejected" } });
    expect(activity?.summary).toBe("menu.png rejected: Prices are missing");
  });
});
