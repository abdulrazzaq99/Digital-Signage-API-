import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { customerContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

async function device() {
  const ctx = await customerContext();
  const session = (await api().post("/api/v1/player/pairing-sessions").send({ deviceId: "DEV-VALIDATE" })).body.data;
  await api().post("/api/v1/screens/pair").set(ctx.auth).send({ code: session.code, name: "Lobby" });
  const credential = (await api().get(`/api/v1/player/pairing-sessions/${session.sessionId}`)).body.data.credential as string;
  return { Authorization: `Bearer ${credential}` };
}

describe("player input validation", () => {
  it("accepts a well-formed heartbeat and rejects a bad IP or resolution", async () => {
    const auth = await device();
    expect((await api().post("/api/v1/player/heartbeat").set(auth).send({ ip: "10.0.0.5", resolution: "1920x1080", storageFree: 1024 })).status).toBe(200);
    expect((await api().post("/api/v1/player/heartbeat").set(auth).send({ ip: "2001:db8::1" })).status).toBe(200);
    const bad = await api().post("/api/v1/player/heartbeat").set(auth).send({ ip: "999.1.1.1", resolution: "big", currentVersion: -1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["body.currentVersion", "body.ip", "body.resolution"]);
  });

  it("caps diagnostics detail by key count and size", async () => {
    const auth = await device();
    expect((await api().post("/api/v1/player/diagnostics").set(auth).send({ event: "decode_error", detail: { file: "a.mp4" } })).status).toBe(202);
    const manyKeys = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]));
    expect((await api().post("/api/v1/player/diagnostics").set(auth).send({ event: "x", detail: manyKeys })).status).toBe(400);
    const huge = await api().post("/api/v1/player/diagnostics").set(auth).send({ event: "x", detail: { log: "x".repeat(9000) } });
    expect(huge.status).toBe(400);
    expect(huge.body.error.details).toEqual([{ path: "body.detail", message: "Detail must be at most 8 KB" }]);
    expect((await api().post("/api/v1/player/diagnostics").set(auth).send({ event: "e".repeat(81) })).status).toBe(400);
  });

  it("rejects a malformed pairing session id", async () => {
    expect((await api().get("/api/v1/player/pairing-sessions/abc")).status).toBe(400);
  });
});
