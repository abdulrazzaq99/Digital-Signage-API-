import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { createCompany, createUser, customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

describe("companies", () => {
  it("Super Admin lists all companies with license and counts", async () => {
    const admin = await superAdminContext();
    await createCompany({ name: "Acme Retail", screenLimit: 20 });
    await createCompany({ name: "City Mall", screenLimit: 50 });
    const res = await api().get("/api/v1/companies").set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ license: { screenLimit: expect.any(Number), state: "ACTIVE" }, counts: { screens: 0, available: expect.any(Number) } });
    expect(res.body.meta).toMatchObject({ page: 1, total: 2 });
  });

  it("customer Admin cannot list companies", async () => {
    const ctx = await customerContext();
    const res = await api().get("/api/v1/companies").set(ctx.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PLATFORM_ONLY");
  });

  it("customer can read only their own company; others are 404", async () => {
    const ctx = await customerContext();
    const other = await createCompany();
    expect((await api().get(`/api/v1/companies/${ctx.company.id}`).set(ctx.auth)).status).toBe(200);
    const res = await api().get(`/api/v1/companies/${other.id}`).set(ctx.auth);
    expect(res.status).toBe(404);
  });

  it("Super Admin creates a company with a license and an activity entry", async () => {
    const admin = await superAdminContext();
    const res = await api().post("/api/v1/companies").set(admin.auth).send({ name: "FreshMart Co.", screenLimit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "FreshMart Co.", code: "00001", license: { screenLimit: 5, state: "ACTIVE" } });
    const log = await prisma.activityLog.findFirst({ where: { action: "company.created" } });
    expect(log?.summary).toContain("FreshMart Co.");
  });

  it("customer Admin can update own details but not status", async () => {
    const ctx = await customerContext();
    const ok = await api().patch(`/api/v1/companies/${ctx.company.id}`).set(ctx.auth).send({ website: "https://acme.example" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.website).toBe("https://acme.example");
    const bad = await api().patch(`/api/v1/companies/${ctx.company.id}`).set(ctx.auth).send({ status: "SUSPENDED" });
    expect(bad.status).toBe(403);
  });
});

describe("users", () => {
  it("lists only users of the caller's company", async () => {
    const ctx = await customerContext();
    await createUser({ companyId: ctx.company.id, companyRole: "VIEWER" });
    const other = await createCompany();
    await createUser({ companyId: other.id });
    const res = await api().get("/api/v1/users").set(ctx.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((u: { role: string }) => ["ADMIN", "VIEWER"].includes(u.role))).toBe(true);
  });

  it("cannot read or edit a user from another company by ID", async () => {
    const ctx = await customerContext();
    const other = await createCompany();
    const foreign = await createUser({ companyId: other.id });
    const res = await api().patch(`/api/v1/users/${foreign.id}`).set(ctx.auth).send({ name: "Hacked" });
    expect(res.status).toBe(404);
  });

  it("Editor cannot create users", async () => {
    const ctx = await customerContext({ companyRole: "EDITOR" });
    const res = await api().post("/api/v1/users").set(ctx.auth).send({ email: "new@test.local", name: "New Person", role: "VIEWER" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
  });

  it("creates an invited user and rejects duplicate emails", async () => {
    const ctx = await customerContext();
    const res = await api().post("/api/v1/users").set(ctx.auth).send({ email: "New@Test.local", name: "New Person", role: "EDITOR" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: "new@test.local", status: "INVITED", role: "EDITOR" });
    const dup = await api().post("/api/v1/users").set(ctx.auth).send({ email: "new@test.local", name: "Again", role: "VIEWER" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("refuses to demote or remove the last Admin", async () => {
    const ctx = await customerContext();
    const demote = await api().patch(`/api/v1/users/${ctx.user.id}`).set(ctx.auth).send({ role: "VIEWER" });
    expect(demote.status).toBe(400);
    expect(demote.body.error.code).toBe("LAST_ADMIN");
    const remove = await api().delete(`/api/v1/users/${ctx.user.id}`).set(ctx.auth);
    expect(remove.status).toBe(400);
  });

  it("Super Admin manages users of a company via X-Company-Id", async () => {
    const admin = await superAdminContext();
    const company = await createCompany();
    const res = await api().post("/api/v1/users").set(admin.auth).set("X-Company-Id", company.id).send({ email: "owner@test.local", name: "Owner", role: "ADMIN", password: "Passw0rd!" });
    expect(res.status).toBe(201);
    const missing = await api().post("/api/v1/users").set(admin.auth).send({ email: "x@test.local", name: "Xavier", role: "ADMIN" });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe("COMPANY_REQUIRED");
  });
});

describe("licenses", () => {
  it("customer reads own license with paired and available counts", async () => {
    const ctx = await customerContext({ screenLimit: 4 });
    await prisma.screen.create({ data: { companyId: ctx.company.id, name: "S1" } });
    const res = await api().get(`/api/v1/companies/${ctx.company.id}/license`).set(ctx.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ screenLimit: 4, paired: 1, available: 3, state: "ACTIVE" });
  });

  it("customer cannot update a license", async () => {
    const ctx = await customerContext();
    const res = await api().put(`/api/v1/companies/${ctx.company.id}/license`).set(ctx.auth).send({ screenLimit: 100 });
    expect(res.status).toBe(403);
  });

  it("lowering the limit below the paired count flags over-limit and keeps screens", async () => {
    const admin = await superAdminContext();
    const company = await createCompany({ screenLimit: 5 });
    await prisma.screen.createMany({ data: [1, 2, 3].map((n) => ({ companyId: company.id, name: `S${n}` })) });
    const res = await api().put(`/api/v1/companies/${company.id}/license`).set(admin.auth).send({ screenLimit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ screenLimit: 2, paired: 3, available: 0, overLimit: true });
    expect(await prisma.screen.count({ where: { companyId: company.id } })).toBe(3);
    const log = await prisma.activityLog.findFirst({ where: { companyId: company.id, action: "license.updated" } });
    expect(log?.status).toBe("PENDING");
    expect(log?.summary).toContain("flagged");
    const raised = await api().put(`/api/v1/companies/${company.id}/license`).set(admin.auth).send({ screenLimit: 6 });
    expect(raised.body.data.overLimit).toBe(false);
  });

  it("Super Admin lists every license", async () => {
    const admin = await superAdminContext();
    await createCompany(); await createCompany();
    const res = await api().get("/api/v1/licenses").set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].company.name).toBeTypeOf("string");
  });
});
