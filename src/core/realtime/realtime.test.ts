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
