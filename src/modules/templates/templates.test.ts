import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../core/db/prisma.js";
import { putObject } from "../../core/storage/s3.js";
import { templateRender } from "../../jobs/template.render.js";
import { customerContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";
import { pngBytes } from "../../test/media.js";

beforeEach(resetDatabase);
afterAll(closeAll);

const fields = [
  { key: "headline", label: "Headline", type: "text", required: true, max: 30 },
  { key: "price", label: "Price", type: "text" },
  { key: "accent", label: "Accent", type: "color" },
  { key: "photo", label: "Product Image", type: "image" },
];

async function imageAsset(companyId: string, color: string) {
  const storageKey = `${companyId}/img-${Math.random().toString(36).slice(2)}/photo.png`;
  await putObject(storageKey, await pngBytes(400, 400, color), "image/png");
  return prisma.mediaAsset.create({ data: { companyId, name: "photo.png", type: "IMAGE", status: "READY", mimeType: "image/png", sizeBytes: BigInt(1), storageKey } });
}

const pixel = async (png: Buffer, x: number, y: number) => {
  const { data } = await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
};

describe("template rendering (B7)", () => {
  it("renders a PNG at the target resolution with the chosen image drawn in", async () => {
    const ctx = await customerContext();
    const t = await prisma.template.create({ data: { name: "Product", category: "Retail", isGlobal: true, fields } });
    const red = await imageAsset(ctx.company.id, "#ff0000");
    const inst = (await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId: t.id, name: "Promo", values: { headline: "Fresh Coffee", price: "£2.50", accent: "#16a34a", photo: red.id } })).body.data;
    expect(inst).toMatchObject({ rendered: false, rendering: true });
    await templateRender({ instanceId: inst.id, companyId: ctx.company.id });

    const done = (await api().get(`/api/v1/template-instances/${inst.id}`).set(ctx.auth)).body.data;
    expect(done).toMatchObject({ rendered: true, rendering: false });
    const res = await fetch(done.outputUrl);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(await sharp(png).metadata()).toMatchObject({ format: "png", width: 1920, height: 1080 });
    // Landscape default layout: the image panel sits on the right; text on the left.
    expect(await pixel(png, Math.round(1920 * 0.75), Math.round(1080 * 0.5))).toEqual([255, 0, 0]);
    expect(await pixel(png, 10, 10)).not.toEqual([255, 0, 0]);
    const row = await prisma.templateInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row).toMatchObject({ outputMimeType: "image/png", outputWidth: 1920, outputHeight: 1080, outputSizeBytes: png.length });
  });

  it("honours a designer's field box and portrait orientation", async () => {
    const ctx = await customerContext();
    const t = await prisma.template.create({ data: { name: "Poster", category: "Retail", isGlobal: true, orientation: "PORTRAIT", fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "photo", label: "Photo", type: "image", box: { x: 0, y: 0, w: 0.5, h: 0.25 }, fit: "cover" }] } });
    const blue = await imageAsset(ctx.company.id, "#0000ff");
    const inst = (await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId: t.id, name: "Poster", values: { title: "Open Late", photo: blue.id } })).body.data;
    await templateRender({ instanceId: inst.id, companyId: ctx.company.id });
    const png = Buffer.from(await (await fetch((await api().get(`/api/v1/template-instances/${inst.id}`).set(ctx.auth)).body.data.outputUrl)).arrayBuffer());
    expect(await sharp(png).metadata()).toMatchObject({ width: 1080, height: 1920 });
    expect(await pixel(png, 100, 100)).toEqual([0, 0, 255]);
    expect(await pixel(png, 900, 100)).not.toEqual([0, 0, 255]);
  });

  it("only accepts ready images from the company's own library for image fields", async () => {
    const ctx = await customerContext();
    const other = await customerContext();
    const t = await prisma.template.create({ data: { name: "Product", category: "Retail", isGlobal: true, fields } });
    const theirs = await imageAsset(other.company.id, "#00ff00");
    for (const photo of ["https://example.com/a.png", theirs.id]) {
      const res = await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId: t.id, name: "Promo", values: { headline: "Hi", photo } });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ path: "photo", message: "Choose a ready image from the media library" }]);
    }
  });

  it("shows the edit as rendering until the new output lands, and skips duplicate jobs", async () => {
    const ctx = await customerContext();
    const t = await prisma.template.create({ data: { name: "Product", category: "Retail", isGlobal: true, fields } });
    const inst = (await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId: t.id, name: "Promo", values: { headline: "One" } })).body.data;
    await templateRender({ instanceId: inst.id, companyId: ctx.company.id });
    const first = await prisma.templateInstance.findUniqueOrThrow({ where: { id: inst.id } });

    const edited = (await api().patch(`/api/v1/template-instances/${inst.id}`).set(ctx.auth).send({ values: { headline: "Two" } })).body.data;
    expect(edited).toMatchObject({ rendered: false, rendering: true });
    expect(edited.outputUrl).toContain(first.outputKey);
    // The client's own render request queues a second job for the same values.
    await api().post(`/api/v1/template-instances/${inst.id}/render`).set(ctx.auth);
    await templateRender({ instanceId: inst.id, companyId: ctx.company.id });
    const second = await prisma.templateInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(second.outputChecksum).not.toBe(first.outputChecksum);
    await templateRender({ instanceId: inst.id, companyId: ctx.company.id });
    expect((await prisma.templateInstance.findUniqueOrThrow({ where: { id: inst.id } })).outputKey).toBe(second.outputKey);
    expect((await api().get(`/api/v1/template-instances/${inst.id}`).set(ctx.auth)).body.data).toMatchObject({ rendered: true, rendering: false });
  });
});
