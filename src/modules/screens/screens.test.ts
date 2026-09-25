import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { isOnline } from "../../core/redis/presence.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

async function startPairing(deviceId = `DEV-${Math.random().toString(36).slice(2, 8)}`) {
  const res = await api().post("/api/v1/player/pairing-sessions").send({ deviceId, model: "Android Box Pro", playerVersion: "1.6.3" });
  expect(res.status).toBe(201);
  return res.body.data as { sessionId: string; code: string };
}

async function pairScreen(auth: Record<string, string>, name = "Lobby Display 01") {
  const session = await startPairing();
  const res = await api().post("/api/v1/screens/pair").set(auth).send({ code: session.code, name, location: "Main Lobby" });
  expect(res.status).toBe(201);
  const poll = await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`);
  expect(poll.body.data.status).toBe("PAIRED");
  return { screen: res.body.data as { id: string }, credential: poll.body.data.credential as string };
}

describe("pairing", () => {

  it("stops re-issuing the credential 10 minutes after pairing, and never for an unpaired screen", async () => {
    const ctx = await customerContext();
    const late = await startPairing();
    const paired = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: late.code, name: "Late" });
    expect((await api().get(`/api/v1/player/pairing-sessions/${late.sessionId}`)).body.data.credential).toBeTypeOf("string");
    await prisma.pairingSession.update({ where: { id: late.sessionId }, data: { consumedAt: new Date(Date.now() - 11 * 60_000) } });
    expect((await api().get(`/api/v1/player/pairing-sessions/${late.sessionId}`)).body.data.credential).toBeNull();

    const gone = await startPairing();
    const res = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: gone.code, name: "Gone" });
    expect((await api().post(`/api/v1/screens/${res.body.data.id}/unpair`).set(ctx.auth)).status).toBeLessThan(300);
    expect((await api().get(`/api/v1/player/pairing-sessions/${gone.sessionId}`)).body.data.credential).toBeNull();
    expect(paired.status).toBe(201);
  });
  it("pairs a device, consumes a licence slot, and issues a credential once", async () => {
    const ctx = await customerContext({ screenLimit: 2 });
    const session = await startPairing("DEV-A");
    const pending = await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`);
    expect(pending.body.data.status).toBe("PENDING");

    const res = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code.toLowerCase(), name: "Reception Display", location: "Lobby", tags: ["lobby"] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Reception Display", status: "OFFLINE", syncState: "PENDING", device: { deviceId: "DEV-A", model: "Android Box Pro" } });

    const first = await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`);
    expect(first.body.data).toMatchObject({ status: "PAIRED", screenId: res.body.data.id });
    expect(first.body.data.credential).toBeTypeOf("string");
    // The device has not used it yet, so a re-poll (lost response) rotates it and hands out a fresh one.
    const second = await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`);
    expect(second.body.data.credential).toBeTypeOf("string");
    expect(second.body.data.credential).not.toBe(first.body.data.credential);
    expect((await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${first.body.data.credential}`)).status).toBe(401);
    expect((await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${second.body.data.credential}`)).status).toBe(200);
    // Once the device has authenticated with it, the session no longer hands out credentials.
    const third = await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`);
    expect(third.body.data).toMatchObject({ status: "PAIRED", credential: null });
    expect((await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${second.body.data.credential}`)).status).toBe(200);

    const license = await api().get(`/api/v1/companies/${ctx.company.id}/license`).set(ctx.auth);
    expect(license.body.data).toMatchObject({ paired: 1, available: 1 });
    const log = await prisma.activityLog.findFirst({ where: { action: "screen.paired" } });
    expect(log?.summary).toContain("1 of 2");
  });

  it("rejects invalid, expired, and reused codes with distinct errors", async () => {
    const ctx = await customerContext();
    const invalid = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: "ZZZZZZ", name: "Nope" });
    expect(invalid.status).toBe(404);
    expect(invalid.body.error.code).toBe("PAIRING_CODE_INVALID");

    const session = await startPairing("DEV-E");
    await prisma.pairingSession.update({ where: { id: session.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "Late" });
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe("PAIRING_CODE_EXPIRED");

    const { screen } = await pairScreen(ctx.auth);
    const used = await prisma.pairingSession.findFirst({ where: { screenId: screen.id } });
    const reuse = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: used!.code, name: "Again" });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("DEVICE_ALREADY_PAIRED");
  });

  it("rejects pairing at the licence limit and allows it after the limit is raised", async () => {
    const ctx = await customerContext({ screenLimit: 1 });
    await pairScreen(ctx.auth, "First");
    const session = await startPairing("DEV-L");
    const blocked = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "Second" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("LICENSE_LIMIT_REACHED");
    expect(blocked.body.error.details).toEqual({ paired: 1, limit: 1 });

    await prisma.license.update({ where: { companyId: ctx.company.id }, data: { screenLimit: 2 } });
    const allowed = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "Second" });
    expect(allowed.status).toBe(201);
  });

  it("blocks pairing when the licence is suspended", async () => {
    const ctx = await customerContext({ licenseState: "SUSPENDED" });
    const session = await startPairing();
    const res = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "Blocked" });
    // The company's users are read-only; the licence check still stops the Super Admin.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("COMPANY_READ_ONLY");
    const admin = await superAdminContext();
    const byAdmin = await api().post("/api/v1/screens/pair").set(admin.auth).set("X-Company-Id", ctx.company.id).send({ code: session.code, name: "Blocked" });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.code).toBe("LICENSE_INACTIVE");
  });

  it("Viewers cannot pair", async () => {
    const ctx = await customerContext({ companyRole: "VIEWER" });
    const session = await startPairing();
    const res = await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "X" });
    expect(res.status).toBe(403);
  });
});

describe("screens", () => {
  it("lists only own screens with filters and hides other tenants by ID", async () => {
    const ctx = await customerContext({ screenLimit: 5 });
    const other = await customerContext({ screenLimit: 5 });
    await pairScreen(ctx.auth, "Lobby A");
    await pairScreen(ctx.auth, "Cafe Board");
    const { screen: foreign } = await pairScreen(other.auth, "Foreign");
    const list = await api().get("/api/v1/screens?search=cafe").set(ctx.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.map((s: { name: string }) => s.name)).toEqual(["Cafe Board"]);
    const all = await api().get("/api/v1/screens").set(ctx.auth);
    expect(all.body.meta.total).toBe(2);
    expect((await api().get(`/api/v1/screens/${foreign.id}`).set(ctx.auth)).status).toBe(404);
    expect((await api().patch(`/api/v1/screens/${foreign.id}`).set(ctx.auth).send({ name: "Hijack" })).status).toBe(404);
  });

  it("updates a screen and moves it between groups", async () => {
    const ctx = await customerContext();
    const { screen } = await pairScreen(ctx.auth);
    const group = await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Lobby & Entrances", description: "Front of house" });
    expect(group.status).toBe(201);
    const res = await api().patch(`/api/v1/screens/${screen.id}`).set(ctx.auth).send({ name: "Reception", groupId: group.body.data.id, tags: ["lobby", "front"] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Reception", tags: ["lobby", "front"], groups: [{ name: "Lobby & Entrances" }] });
    const detail = await api().get(`/api/v1/screen-groups/${group.body.data.id}`).set(ctx.auth);
    expect(detail.body.data.screenCount).toBe(1);
  });

  it("unpairs a screen, releases the licence slot, and revokes the device credential", async () => {
    const ctx = await customerContext({ screenLimit: 1 });
    const { screen, credential } = await pairScreen(ctx.auth);
    expect((await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${credential}`)).status).toBe(200);
    const res = await api().post(`/api/v1/screens/${screen.id}/unpair`).set(ctx.auth);
    expect(res.status).toBe(204);
    expect((await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${credential}`)).status).toBe(401);
    expect((await api().get(`/api/v1/screens/${screen.id}`).set(ctx.auth)).status).toBe(404);
    const license = await api().get(`/api/v1/companies/${ctx.company.id}/license`).set(ctx.auth);
    expect(license.body.data.available).toBe(1);
  });

  it("dispatches remote commands and records activity", async () => {
    const ctx = await customerContext();
    const { screen } = await pairScreen(ctx.auth);
    const res = await api().post(`/api/v1/screens/${screen.id}/commands`).set(ctx.auth).send({ command: "restart_player" });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ dispatched: true, online: false });
    const log = await prisma.activityLog.findFirst({ where: { action: "screen.remote.restart_player" } });
    expect(log?.status).toBe("PENDING");
  });

  it("group CRUD validates membership and deleting keeps screens", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const { screen } = await pairScreen(ctx.auth);
    const { screen: foreign } = await pairScreen(other.auth);
    const bad = await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Mixed", screenIds: [screen.id, foreign.id] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("SCREEN_NOT_FOUND");
    const good = await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Lobby", screenIds: [screen.id] });
    expect(good.status).toBe(201);
    expect(good.body.data).toMatchObject({ screenCount: 1, onlineCount: 0 });
    const dup = await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Lobby" });
    expect(dup.status).toBe(409);
    expect((await api().delete(`/api/v1/screen-groups/${good.body.data.id}`).set(ctx.auth)).status).toBe(204);
    expect((await api().get(`/api/v1/screens/${screen.id}`).set(ctx.auth)).status).toBe(200);
  });
});

describe("player", () => {
  it("heartbeat marks the screen online, updates device info, and returns the manifest version", async () => {
    const ctx = await customerContext();
    const { screen, credential } = await pairScreen(ctx.auth);
    const res = await api().post("/api/v1/player/heartbeat").set("Authorization", `Bearer ${credential}`).send({ playerVersion: "1.7.0", ip: "10.0.0.5", storageFree: 5_000_000_000, state: "PLAYING" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ manifestVersion: 0 });
    expect(await isOnline(screen.id)).toBe(true);
    const detail = await api().get(`/api/v1/screens/${screen.id}`).set(ctx.auth);
    expect(detail.body.data).toMatchObject({ status: "ONLINE", device: { playerVersion: "1.7.0", ip: "10.0.0.5" } });
  });

  it("sync-ack updates ack version and sync state", async () => {
    const ctx = await customerContext();
    const { screen, credential } = await pairScreen(ctx.auth);
    await prisma.screen.update({ where: { id: screen.id }, data: { manifestVersion: 3 } });
    const stale = await api().post("/api/v1/player/sync-ack").set("Authorization", `Bearer ${credential}`).send({ version: 2, status: "activated" });
    expect(stale.status).toBe(204);
    expect((await prisma.screen.findUnique({ where: { id: screen.id } }))?.syncState).toBe("PENDING");
    await api().post("/api/v1/player/sync-ack").set("Authorization", `Bearer ${credential}`).send({ version: 3, status: "activated" });
    const after = await prisma.screen.findUnique({ where: { id: screen.id } });
    expect(after).toMatchObject({ ackVersion: 3, syncState: "SYNCED" });
    await api().post("/api/v1/player/sync-ack").set("Authorization", `Bearer ${credential}`).send({ version: 3, status: "failed", error: "disk full" });
    expect((await prisma.activityLog.findFirst({ where: { action: "screen.sync.failed" } }))?.summary).toContain("disk full");
  });

  it("manifest reflects the current playlist assignment with signed asset URLs", async () => {
    const ctx = await customerContext();
    const { screen, credential } = await pairScreen(ctx.auth);
    const asset = await prisma.mediaAsset.create({ data: { companyId: ctx.company.id, name: "hero.jpg", type: "IMAGE", status: "READY", mimeType: "image/jpeg", sizeBytes: BigInt(1234), storageKey: `${ctx.company.id}/hero.jpg` } });
    const playlist = await prisma.playlist.create({ data: { companyId: ctx.company.id, name: "Summer", status: "PUBLISHED", version: 1, items: { create: [{ position: 0, assetId: asset.id, durationSec: 15 }] } } });
    await prisma.screenAssignment.create({ data: { screenId: screen.id, kind: "PLAYLIST", refId: playlist.id, version: 1 } });
    await prisma.screen.update({ where: { id: screen.id }, data: { manifestVersion: 1 } });
    const res = await api().get("/api/v1/player/manifest").set("Authorization", `Bearer ${credential}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ version: 1, assignment: { kind: "PLAYLIST", name: "Summer" }, items: [{ assetId: asset.id, position: 0, durationSec: 15 }], assets: [{ id: asset.id, type: "IMAGE", mimeType: "image/jpeg", sizeBytes: 1234 }] });
    expect(res.body.data.assets[0].url).toContain("X-Amz-Signature");
  });

  it("rejects unauthenticated player calls", async () => {
    expect((await api().get("/api/v1/player/manifest")).status).toBe(401);
    const res = await api().post("/api/v1/player/heartbeat").set("Authorization", "Bearer not-a-credential").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("DEVICE_UNAUTHORIZED");
  });
});

describe("list filters", () => {
  it("treats personal=false as false, not as a truthy string", async () => {
    const ctx = await customerContext();
    await prisma.screen.create({ data: { companyId: ctx.company.id, name: "Shared", pairingStatus: "PAIRED" } });
    await prisma.screen.create({ data: { companyId: ctx.company.id, name: "Mine", pairingStatus: "PAIRED", isPersonal: true } });
    const shared = await api().get("/api/v1/screens?personal=false").set(ctx.auth);
    expect(shared.body.data.map((s: { name: string }) => s.name)).toEqual(["Shared"]);
    const personal = await api().get("/api/v1/screens?personal=true").set(ctx.auth);
    expect(personal.body.data.map((s: { name: string }) => s.name)).toEqual(["Mine"]);
    const invalid = await api().get("/api/v1/screens?personal=maybe").set(ctx.auth);
    expect(invalid.status).toBe(400);
  });
});
