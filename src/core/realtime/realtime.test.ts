import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../db/prisma.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";
import { Events } from "./events.js";
import { closeRealtime, initRealtime } from "./server.js";

let baseUrl = "";
const server = createServer(createApp());

beforeAll(async () => {
  initRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});
beforeEach(resetDatabase);
afterAll(async () => {
  await closeRealtime();
  await new Promise<void>((r) => server.close(() => r()));
  await closeAll();
});

async function pairedScreen() {
  const ctx = await customerContext();
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: "DEV-RT" })).body.data;
  const screen = (await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "RT Screen" })).body.data;
  const credential = (await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`)).body.data.credential as string;
  return { ctx, screen, credential };
}

describe("realtime", () => {
  it("rejects a player socket without a valid device credential", async () => {
    const err = await new Promise<string>((resolve) => {
      const s = ioClient(`${baseUrl}/player`, { auth: { token: "bogus" }, transports: ["websocket"], reconnection: false });
      s.on("connect_error", (e) => { resolve(e.message); s.close(); });
    });
    expect(err).toBe("DEVICE_UNAUTHORIZED");
  });

  it("marks a screen online on player connect and notifies the company room", async () => {
    const { ctx, screen, credential } = await pairedScreen();
    const app = ioClient(`${baseUrl}/app`, { auth: { token: ctx.tokens.accessToken }, transports: ["websocket"] });
    await new Promise<void>((r) => app.on("connect", () => r()));
    const presence = new Promise<{ screenId: string; status: string }>((r) => app.on(Events.presence, r));
    const player = ioClient(`${baseUrl}/player`, { auth: { token: credential }, transports: ["websocket"] });
    await new Promise<void>((r) => player.on("connect", () => r()));
    expect(await presence).toMatchObject({ screenId: screen.id, status: "ONLINE" });
    expect((await prisma.screen.findUnique({ where: { id: screen.id } }))?.status).toBe("ONLINE");

    const ack = new Promise<{ screenId: string; syncState: string }>((r) => app.on(Events.syncAck, r));
    player.emit(Events.syncAck, { version: 0 });
    expect(await ack).toMatchObject({ screenId: screen.id, syncState: "SYNCED" });

    const remote = new Promise<unknown>((r) => player.on(Events.remoteRefresh, r));
    await api().post(`/api/v1/screens/${screen.id}/commands`).set(ctx.auth).send({ command: "refresh" });
    expect(await remote).toMatchObject({ by: ctx.user.id });

    player.close(); app.close();
  });

  it("rejects malformed player payloads with socket.error and keeps the connection", async () => {
    const { screen, credential } = await pairedScreen();
    const player = ioClient(`${baseUrl}/player`, { auth: { token: credential }, transports: ["websocket"] });
    await new Promise<void>((r) => player.on("connect", () => r()));
    const errors: { event: string; code: string }[] = [];
    player.on(Events.socketError, (e) => errors.push(e));

    const bad = await player.emitWithAck(Events.syncAck, { version: 2 ** 31 + 1 });
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD", event: Events.syncAck } });
    player.emit(Events.syncAck, { version: -1 });
    player.emit(Events.syncAck, "not an object");
    player.emit(Events.presence, 42);
    await new Promise((r) => setTimeout(r, 200));
    expect(errors.map((e) => e.code)).toEqual(["INVALID_PAYLOAD", "INVALID_PAYLOAD", "INVALID_PAYLOAD", "INVALID_PAYLOAD"]);
    expect(player.connected).toBe(true);
    expect((await prisma.screen.findUniqueOrThrow({ where: { id: screen.id } })).ackVersion).toBe(0);
    expect(await player.emitWithAck(Events.presence, {})).toEqual({ ok: true });
    player.close();
  });

  it("handles a socket sync ack like the HTTP one, including canvas readiness", async () => {
    const { screen, credential } = await pairedScreen();
    await prisma.screen.update({ where: { id: screen.id }, data: { manifestVersion: 3 } });
    const other = await prisma.screen.create({ data: { companyId: (await prisma.screen.findUniqueOrThrow({ where: { id: screen.id } })).companyId, name: "Other" } });
    const set = await prisma.canvasSet.create({ data: { companyId: other.companyId, name: "Wall", members: { create: [{ screenId: screen.id, position: 0 }, { screenId: other.id, position: 1 }] } } });
    const player = ioClient(`${baseUrl}/player`, { auth: { token: credential }, transports: ["websocket"] });
    await new Promise<void>((r) => player.on("connect", () => r()));

    expect(await player.emitWithAck(Events.syncAck, { version: 3, status: "downloaded" })).toEqual({ ok: true });
    let row = await prisma.screen.findUniqueOrThrow({ where: { id: screen.id } });
    expect(row).toMatchObject({ syncState: "SYNCING", ackVersion: 0 });
    expect((await prisma.canvasMember.findFirstOrThrow({ where: { setId: set.id, screenId: screen.id } })).ready).toBe(true);

    await player.emitWithAck(Events.syncAck, { version: 3 });
    row = await prisma.screen.findUniqueOrThrow({ where: { id: screen.id } });
    expect(row).toMatchObject({ syncState: "SYNCED", ackVersion: 3 });
    player.close();
  });

  it("refuses an /app socket for a deactivated user whose token has not expired", async () => {
    const { ctx } = await pairedScreen();
    await prisma.user.update({ where: { id: ctx.user.id }, data: { isActive: false } });
    const err = await new Promise<string>((resolve) => {
      const s = ioClient(`${baseUrl}/app`, { auth: { token: ctx.tokens.accessToken }, transports: ["websocket"], reconnection: false });
      s.on("connect_error", (e) => { resolve(e.message); s.close(); });
    });
    expect(err).toBe("ACCOUNT_DISABLED");
  });

  it("delivers offer.published exactly once to a Super Admin socket", async () => {
    const admin = await superAdminContext();
    const offer = await prisma.offer.create({ data: { title: "Bundle deal", category: "Hardware", summary: "Two screens for one", description: "Buy one get one free on displays", instructions: "Call us", contact: { name: "Sales" } } });
    const socket = ioClient(`${baseUrl}/app`, { auth: { token: admin.tokens.accessToken }, transports: ["websocket"] });
    await new Promise<void>((r) => socket.on("connect", () => r()));
    let received = 0;
    socket.on(Events.offerPublished, () => { received++; });
    expect((await api().post(`/api/v1/offers/${offer.id}/publish`).set(admin.auth)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    socket.close();
    expect(received).toBe(1);
  });
});
