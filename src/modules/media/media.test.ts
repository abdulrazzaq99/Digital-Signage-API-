import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { customerContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";
import { mediaConvert } from "../../jobs/media.convert.js";
import { mediaCleanup } from "../../jobs/media.cleanup.js";
import { headObject } from "../../core/storage/s3.js";

beforeEach(resetDatabase);
afterAll(closeAll);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function upload(auth: Record<string, string>, opts: { fileName?: string; contentType?: string; bytes?: Buffer; sizeBytes?: number } = {}) {
  const contentType = opts.contentType ?? "image/png";
  const bytes = opts.bytes ?? PNG;
  const res = await api().post("/api/v1/media/upload-url").set(auth).send({ fileName: opts.fileName ?? "pixel.png", contentType, sizeBytes: opts.sizeBytes ?? bytes.length, tags: ["test"] });
  expect(res.status).toBe(201);
  const put = await fetch(res.body.data.uploadUrl, { method: "PUT", body: bytes, headers: { "Content-Type": contentType } });
  expect(put.status).toBe(200);
  return res.body.data as { asset: { id: string }; uploadUrl: string };
}

describe("media upload flow", () => {
  it("issues a presigned URL, accepts the upload, and marks images READY on finalize", async () => {
    const ctx = await customerContext();
    const { asset } = await upload(ctx.auth);
    const before = await api().get(`/api/v1/media/${asset.id}`).set(ctx.auth);
    expect(before.body.data.status).toBe("UPLOADING");
    const fin = await api().post(`/api/v1/media/${asset.id}/finalize`).set(ctx.auth).send({ width: 1, height: 1 });
    expect(fin.status).toBe(200);
    expect(fin.body.data).toMatchObject({ status: "READY", sizeBytes: PNG.length, width: 1, tags: ["test"], usedIn: [] });
    expect(fin.body.data.checksum).toBeTypeOf("string");
    const again = await api().post(`/api/v1/media/${asset.id}/finalize`).set(ctx.auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_FINALIZED");
  });

  it("marks video and PDF as PROCESSING and the conversion job makes them READY with page derivatives", async () => {
    const ctx = await customerContext();
    const { asset } = await upload(ctx.auth, { fileName: "guide.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4 test") });
    const fin = await api().post(`/api/v1/media/${asset.id}/finalize`).set(ctx.auth).send({ pages: 3 });
    expect(fin.body.data.status).toBe("PROCESSING");
    await mediaConvert({ assetId: asset.id, companyId: ctx.company.id });
    const after = await api().get(`/api/v1/media/${asset.id}`).set(ctx.auth);
    expect(after.body.data.status).toBe("READY");
    expect(await prisma.mediaDerivative.count({ where: { assetId: asset.id, kind: "PDF_PAGE" } })).toBe(3);
  });

  it("rejects unsupported types and oversized declarations before any upload", async () => {
    const ctx = await customerContext();
    const bad = await api().post("/api/v1/media/upload-url").set(ctx.auth).send({ fileName: "page.html", contentType: "text/html", sizeBytes: 10 });
    expect(bad.status).toBe(400);
    const big = await api().post("/api/v1/media/upload-url").set(ctx.auth).send({ fileName: "huge.mp4", contentType: "video/mp4", sizeBytes: 600 * 1024 * 1024 });
    expect(big.status).toBe(400);
  });

  it("fails finalize when nothing was uploaded", async () => {
    const ctx = await customerContext();
    const res = await api().post("/api/v1/media/upload-url").set(ctx.auth).send({ fileName: "ghost.png", contentType: "image/png", sizeBytes: 10 });
    const fin = await api().post(`/api/v1/media/${res.body.data.asset.id}/finalize`).set(ctx.auth).send({});
    expect(fin.status).toBe(400);
    expect(fin.body.error.code).toBe("UPLOAD_MISSING");
  });

  it("Viewers cannot upload", async () => {
    const ctx = await customerContext({ companyRole: "VIEWER" });
    const res = await api().post("/api/v1/media/upload-url").set(ctx.auth).send({ fileName: "x.png", contentType: "image/png", sizeBytes: 10 });
    expect(res.status).toBe(403);
  });
});

describe("media access and deletion", () => {
  it("lists with stats, and hides other tenants' assets including download URLs", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const { asset } = await upload(ctx.auth);
    await api().post(`/api/v1/media/${asset.id}/finalize`).set(ctx.auth).send({});
    const list = await api().get("/api/v1/media").set(ctx.auth);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.stats).toMatchObject({ total: 1, ready: 1, failed: 0 });
    expect((await api().get(`/api/v1/media/${asset.id}`).set(other.auth)).status).toBe(404);
    expect((await api().get(`/api/v1/media/${asset.id}/download-url`).set(other.auth)).status).toBe(404);
    const dl = await api().get(`/api/v1/media/${asset.id}/download-url`).set(ctx.auth);
    expect(dl.status).toBe(200);
    expect((await fetch(dl.body.data.url)).status).toBe(200);
  });

  it("refuses to delete media used by a playlist unless forced, then removes the items", async () => {
    const ctx = await customerContext();
    const { asset } = await upload(ctx.auth);
    await api().post(`/api/v1/media/${asset.id}/finalize`).set(ctx.auth).send({});
    const playlist = await prisma.playlist.create({ data: { companyId: ctx.company.id, name: "Summer", items: { create: [{ position: 0, assetId: asset.id, durationSec: 10 }] } } });
    const detail = await api().get(`/api/v1/media/${asset.id}`).set(ctx.auth);
    expect(detail.body.data.usedIn).toEqual([{ id: playlist.id, name: "Summer", kind: "PLAYLIST" }]);
    const blocked = await api().delete(`/api/v1/media/${asset.id}`).set(ctx.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("MEDIA_IN_USE");
    const notForced = await api().delete(`/api/v1/media/${asset.id}?force=false`).set(ctx.auth);
    expect(notForced.status).toBe(409);
    expect(notForced.body.error.code).toBe("MEDIA_IN_USE");
    const forced = await api().delete(`/api/v1/media/${asset.id}?force=true`).set(ctx.auth);
    expect(forced.status).toBe(204);
    expect(await prisma.playlistItem.count({ where: { playlistId: playlist.id } })).toBe(0);
    expect((await prisma.activityLog.findFirst({ where: { action: "media.deleted" } }))?.summary).toContain("removed from 1 playlist");
  });

  it("retries a failed asset", async () => {
    const ctx = await customerContext();
    const { asset } = await upload(ctx.auth);
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "FAILED", failureReason: "boom" } });
    const res = await api().post(`/api/v1/media/${asset.id}/retry`).set(ctx.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "PROCESSING", failureReason: null });
  });
});

describe("resumable uploads", () => {
  it("scales the upload URL lifetime with the file size", async () => {
    const ctx = await customerContext();
    const small = await api().post("/api/v1/media/upload-url").set(ctx.auth).send({ fileName: "a.png", contentType: "image/png", sizeBytes: 50_000 });
    expect(small.body.data.expiresInSec).toBe(15 * 60);
    const big = await api().post("/api/v1/media/upload-url").set(ctx.auth).send({ fileName: "b.mp4", contentType: "video/mp4", sizeBytes: 400 * 1_048_576 });
    expect(big.body.data.expiresInSec).toBeGreaterThan(60 * 60);
    expect(big.body.data.expiresInSec).toBeLessThanOrEqual(6 * 60 * 60);
  });

  it("re-issues an upload URL for the same asset instead of creating a new one", async () => {
    const ctx = await customerContext();
    const first = await api().post("/api/v1/media/upload-url").set(ctx.auth).send({ fileName: "pixel.png", contentType: "image/png", sizeBytes: PNG.length });
    const id = first.body.data.asset.id as string;
    const again = await api().post(`/api/v1/media/${id}/upload-url`).set(ctx.auth);
    expect(again.status).toBe(200);
    expect(again.body.data.asset.id).toBe(id);
    expect(again.body.data.expiresInSec).toBe(15 * 60);
    expect((await fetch(again.body.data.uploadUrl, { method: "PUT", body: PNG, headers: { "Content-Type": "image/png" } })).status).toBe(200);
    expect((await api().post(`/api/v1/media/${id}/finalize`).set(ctx.auth).send({})).body.data.status).toBe("READY");
    expect(await prisma.mediaAsset.count()).toBe(1);

    const done = await api().post(`/api/v1/media/${id}/upload-url`).set(ctx.auth);
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe("NOT_UPLOADING");
    const other = await customerContext();
    expect((await api().post(`/api/v1/media/${id}/upload-url`).set(other.auth)).status).toBe(404);
  });

  it("cleans up uploads abandoned for more than 24 hours", async () => {
    const ctx = await customerContext();
    const stale = await upload(ctx.auth, { fileName: "stale.png" });
    const fresh = await upload(ctx.auth, { fileName: "fresh.png" });
    const finished = await upload(ctx.auth, { fileName: "done.png" });
    await api().post(`/api/v1/media/${finished.asset.id}/finalize`).set(ctx.auth).send({});
    const old = new Date(Date.now() - 25 * 3600_000);
    await prisma.$executeRaw`UPDATE "MediaAsset" SET "updatedAt" = ${old} WHERE "id" IN (${stale.asset.id}, ${finished.asset.id})`;
    const staleKey = (await prisma.mediaAsset.findUniqueOrThrow({ where: { id: stale.asset.id } })).storageKey;

    expect(await mediaCleanup()).toEqual({ removed: 1 });
    expect((await prisma.mediaAsset.findMany({ orderBy: { name: "asc" } })).map((m) => m.name)).toEqual(["done.png", "fresh.png"]);
    expect(await headObject(staleKey)).toBeNull();
  });
});
