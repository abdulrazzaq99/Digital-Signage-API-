import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import { redis } from "../redis/client.js";
import { sha256 } from "../auth/tokens.js";
import { licenseExpirySweep } from "../../jobs/license.expiry.js";
import { refreshGraceKey } from "../../modules/auth/auth.service.js";
import { createUser, customerContext, login, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

async function pairedScreen(auth: Record<string, string>) {
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: `D-${Math.random().toString(36).slice(2, 10)}` })).body.data;
  const screen = (await api().post("/api/v1/screens/pair").set(auth).send({ code: session.code, name: "Lobby" })).body.data as { id: string };
  const credential = (await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`)).body.data.credential as string;
  return { ...screen, credential };
}

describe("company read-only mode", () => {
  it("lets a suspended company's users sign in and read, but refuses every change", async () => {
    const ctx = await customerContext();
    const screen = await pairedScreen(ctx.auth);
    await prisma.company.update({ where: { id: ctx.company.id }, data: { status: "SUSPENDED" } });

    const again = await login(ctx.user.email, ctx.user.password);
    const auth = { Authorization: `Bearer ${again.accessToken}` };
    const me = await api().get("/api/v1/auth/me").set(auth);
    expect(me.body.data.readOnlyReason).toBe("COMPANY_SUSPENDED");
    expect((await api().get("/api/v1/playlists").set(auth)).status).toBe(200);
    expect((await api().post("/api/v1/schedules/check-conflicts").set(auth).send({ playlistId: "x", targetKind: "SCREEN", targetId: screen.id, startsAt: new Date().toISOString() })).status).toBe(200);

    const create = await api().post("/api/v1/playlists").set(auth).send({ name: "New" });
    expect(create.status).toBe(403);
    expect(create.body.error).toMatchObject({ code: "COMPANY_READ_ONLY", message: "This account is suspended. Contact your administrator." });
    expect((await api().patch(`/api/v1/screens/${screen.id}`).set(auth).send({ name: "Renamed" })).body.error.code).toBe("COMPANY_READ_ONLY");
    expect((await api().post("/api/v1/campaigns/any/attempts").set(auth).set("Idempotency-Key", "a1")).body.error.code).toBe("COMPANY_READ_ONLY");

    // Profile, password and push subscriptions stay open; so do the players.
    expect((await api().patch("/api/v1/users/me").set(auth).send({ name: "Still Me" })).status).toBe(200);
    expect((await api().post("/api/v1/notifications/subscriptions").set(auth).send({ externalId: "push-123" })).status).toBe(201);
    const device = { Authorization: `Bearer ${screen.credential}` };
    expect((await api().post("/api/v1/player/heartbeat").set(device).send({ state: "PLAYING" })).status).toBe(200);
    expect((await api().get("/api/v1/player/manifest").set(device)).status).toBe(200);
    expect((await api().post("/api/v1/player/sync-ack").set(device).send({ version: 0 })).status).toBe(204);

    // The Super Admin manages the company and is never blocked.
    const admin = await superAdminContext();
    const managed = await api().post("/api/v1/playlists").set(admin.auth).set("X-Company-Id", ctx.company.id).send({ name: "By admin" });
    expect(managed.status).toBe(201);
    expect((await api().get("/api/v1/auth/me").set(admin.auth)).body.data.readOnlyReason).toBeNull();
  });

  it("treats a licence past its expiry as expired, and the sweep records it", async () => {
    const ctx = await customerContext();
    expect((await api().get("/api/v1/auth/me").set(ctx.auth)).body.data.readOnlyReason).toBeNull();
    await prisma.license.update({ where: { companyId: ctx.company.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const res = await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "New" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "COMPANY_READ_ONLY", message: "This account's licence has expired. Contact your administrator." });
    expect((await api().get("/api/v1/auth/me").set(ctx.auth)).body.data.readOnlyReason).toBe("LICENSE_EXPIRED");

    const future = await customerContext();
    await prisma.license.update({ where: { companyId: future.company.id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });
    expect(await licenseExpirySweep()).toEqual({ expired: 1 });
    expect((await prisma.license.findUnique({ where: { companyId: ctx.company.id } }))?.state).toBe("EXPIRED");
    expect((await prisma.license.findUnique({ where: { companyId: future.company.id } }))?.state).toBe("ACTIVE");
    expect(await prisma.activityLog.count({ where: { action: "license.expired", companyId: ctx.company.id } })).toBe(1);
    expect(await licenseExpirySweep()).toEqual({ expired: 0 });
  });

  it("locks the company when its licence is suspended", async () => {
    const ctx = await customerContext({ licenseState: "SUSPENDED" });
    expect((await api().get("/api/v1/auth/me").set(ctx.auth)).body.data.readOnlyReason).toBe("LICENSE_SUSPENDED");
    expect((await api().delete("/api/v1/playlists/whatever").set(ctx.auth)).body.error.code).toBe("COMPANY_READ_ONLY");
  });
});

describe("account deactivation", () => {
  it("stops a deactivated user's access and refresh tokens at once", async () => {
    const ctx = await customerContext();
    const editor = await createUser({ companyId: ctx.company.id, companyRole: "EDITOR" });
    const tokens = await login(editor.email, editor.password);
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    expect((await api().get("/api/v1/playlists").set(auth)).status).toBe(200);

    expect((await api().patch(`/api/v1/users/${editor.id}`).set(ctx.auth).send({ isActive: false })).status).toBe(200);
    const denied = await api().get("/api/v1/playlists").set(auth);
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe("ACCOUNT_DISABLED");
    expect(await prisma.refreshToken.count({ where: { userId: editor.id, revokedAt: null } })).toBe(0);
    expect((await api().post("/api/v1/auth/refresh").send({ refreshToken: tokens.refreshToken })).status).toBe(401);
  });

  it("applies a role change to existing access tokens", async () => {
    const ctx = await customerContext();
    const editor = await createUser({ companyId: ctx.company.id, companyRole: "EDITOR" });
    const auth = { Authorization: `Bearer ${(await login(editor.email, editor.password)).accessToken}` };
    await api().patch(`/api/v1/users/${editor.id}`).set(ctx.auth).send({ role: "VIEWER" });
    expect((await api().post("/api/v1/playlists").set(auth).send({ name: "Nope" })).body.error.code).toBe("INSUFFICIENT_ROLE");
  });

  it("refuses an Admin deactivating or demoting themselves", async () => {
    const ctx = await customerContext();
    await createUser({ companyId: ctx.company.id, companyRole: "ADMIN" });
    const off = await api().patch(`/api/v1/users/${ctx.user.id}`).set(ctx.auth).send({ isActive: false });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("SELF_CHANGE");
    expect((await api().patch(`/api/v1/users/${ctx.user.id}`).set(ctx.auth).send({ role: "EDITOR" })).body.error.code).toBe("SELF_CHANGE");
    expect((await api().patch(`/api/v1/users/${ctx.user.id}`).set(ctx.auth).send({ name: "Renamed", role: "ADMIN" })).status).toBe(200);
  });
});

describe("refresh grace cache", () => {
  it("stores the rotated pair encrypted, not as readable JSON", async () => {
    const user = await createUser();
    const first = await login(user.email, user.password);
    const rotated = (await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken })).body.data;
    const stored = await redis.get(refreshGraceKey(sha256(first.refreshToken)));
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(rotated.refreshToken);
    expect(stored).not.toContain(rotated.accessToken);
    expect(stored!.startsWith("v1.")).toBe(true);
    // Within the grace window the same pair still comes back.
    const replay = await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(replay.body.data.refreshToken).toBe(rotated.refreshToken);
  });
});
