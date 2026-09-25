import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

const duplicate = (path: string, message: string) => ({ code: "DUPLICATE", message, details: [{ path, message }] });

describe("unique names", () => {
  it("refuses a playlist name already used in the company, trimmed and in any case", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const first = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Morning Menu" })).body.data;
    const dup = await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "  morning MENU " });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject(duplicate("body.name", "A playlist with this name already exists"));
    // Another company may use it, and a playlist may keep its own name.
    expect((await api().post("/api/v1/playlists").set(other.auth).send({ name: "Morning Menu" })).status).toBe(201);
    expect((await api().patch(`/api/v1/playlists/${first.id}`).set(ctx.auth).send({ name: "morning menu" })).status).toBe(200);
    const second = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Evening" })).body.data;
    expect((await api().patch(`/api/v1/playlists/${second.id}`).set(ctx.auth).send({ name: "Morning menu" })).body.error.code).toBe("DUPLICATE");
  });

  it("gives each duplicated playlist a free copy name", async () => {
    const ctx = await customerContext();
    const p = (await api().post("/api/v1/playlists").set(ctx.auth).send({ name: "Menu" })).body.data;
    const names = [];
    for (let i = 0; i < 3; i++) names.push((await api().post(`/api/v1/playlists/${p.id}/duplicate`).set(ctx.auth)).body.data.name);
    expect(names).toEqual(["Menu (copy)", "Menu (copy 2)", "Menu (copy 3)"]);
  });

  it("refuses duplicate screen groups, canvases, layouts and template instances per company", async () => {
    const ctx = await customerContext();
    await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "Lobby" });
    expect((await api().post("/api/v1/screen-groups").set(ctx.auth).send({ name: "LOBBY" })).body.error).toMatchObject(duplicate("body.name", "A screen group with this name already exists"));

    await prisma.layout.create({ data: { presetId: "p-full", name: "Full", isPreset: true, zones: { create: [{ index: 0, name: "Main", x: 0, y: 0, w: 1, h: 1 }] } } });
    // A company layout may share a preset's name.
    expect((await api().post("/api/v1/layouts").set(ctx.auth).send({ presetId: "p-full", name: "Full" })).status).toBe(201);
    expect((await api().post("/api/v1/layouts").set(ctx.auth).send({ presetId: "p-full", name: "full" })).body.error.code).toBe("DUPLICATE");

    const template = await prisma.template.create({ data: { name: "Promo", category: "Retail", fields: [{ key: "headline", label: "Headline", type: "text" }] } });
    await prisma.templateInstance.create({ data: { companyId: ctx.company.id, templateId: template.id, name: "Spring", values: {} } });
    expect((await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId: template.id, name: "spring", values: { headline: "Hi" } })).body.error.code).toBe("DUPLICATE");

    await prisma.canvasSet.create({ data: { companyId: ctx.company.id, name: "Wall" } });
    expect((await api().post("/api/v1/canvas").set(ctx.auth).send({ name: "wall", screenIds: ["a", "b"] })).body.error.code).toBe("DUPLICATE");
  });

  it("refuses duplicate company names, campaign titles and offer titles, and allocates distinct company codes under concurrency", async () => {
    const admin = await superAdminContext();
    const body = (name: string) => ({ name, screenLimit: 5 });
    const created = await Promise.all(["Acme", "Globex", "Initech", "Umbrella", "Hooli"].map((n) => api().post("/api/v1/companies").set(admin.auth).send(body(n))));
    expect(created.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(created.map((r) => r.body.data.code)).size).toBe(5);
    expect((await api().post("/api/v1/companies").set(admin.auth).send(body(" acme "))).body.error).toMatchObject(duplicate("body.name", "A company with this name already exists"));

    const offer = { title: "Bundle deal", category: "Hardware", summary: "Two screens for one price", description: "Buy one display and get one free", instructions: "Call us", contact: { name: "Sales" } };
    expect((await api().post("/api/v1/offers").set(admin.auth).send(offer)).status).toBe(201);
    expect((await api().post("/api/v1/offers").set(admin.auth).send({ ...offer, title: "BUNDLE DEAL" })).body.error).toMatchObject(duplicate("body.title", "An offer with this title already exists"));

    const window = { startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), prizes: [{ name: "Mug", quantity: 1 }] };
    expect((await api().post("/api/v1/campaigns").set(admin.auth).send({ title: "Spring", ...window })).status).toBe(201);
    expect((await api().post("/api/v1/campaigns").set(admin.auth).send({ title: "spring", ...window })).body.error).toMatchObject(duplicate("body.title", "A campaign with this title already exists"));
  });
});
