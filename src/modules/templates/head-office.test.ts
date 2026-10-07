import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getObjectBuffer } from "../../core/storage/s3.js";
import { prisma } from "../../core/db/prisma.js";
import { templateRender } from "../../jobs/template.render.js";
import { customerContext, superAdminContext } from "../../test/factories.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";
import { pngBytes } from "../../test/media.js";

beforeEach(resetDatabase);
afterAll(closeAll);

/** Uploads a Head Office image through the API and returns its key. */
async function headOfficeImage(auth: Record<string, string>, color: string) {
  const bytes = await pngBytes(400, 400, color);
  const res = await api().post("/api/v1/templates/images/upload-url").set(auth).send({ fileName: "gum.png", contentType: "image/png", sizeBytes: bytes.length });
  expect(res.status).toBe(201);
  expect(res.body.data.key).toMatch(/^head-office\/templates\//);
  expect((await fetch(res.body.data.uploadUrl, { method: "PUT", body: bytes, headers: { "Content-Type": "image/png" } })).status).toBe(200);
  return res.body.data.key as string;
}

const pixel = async (png: Buffer, x: number, y: number) => {
  const { data } = await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
};

describe("Head Office templates", () => {
  it("lets Head Office fix some fields and the location fill the rest", async () => {
    const admin = await superAdminContext();
    const ctx = await customerContext();
    const photo = await headOfficeImage(admin.auth, "#ff0000");
    const t = await api().post("/api/v1/templates").set(admin.auth).send({
      name: "Extra Gum Promotion", category: "Promotion",
      fields: [
        { key: "headline", label: "Headline", type: "text", locked: true, default: "Extra Gum" },
        { key: "photo", label: "Product", type: "image", locked: true, default: photo, box: { x: 0.5, y: 0, w: 0.5, h: 1 }, fit: "cover" },
        { key: "price", label: "Price", type: "text", required: true, default: "10 kr" },
      ],
    });
    expect(t.status).toBe(201);
    expect(t.body.data.fields[0]).toMatchObject({ locked: true, default: "Extra Gum" });
    expect(Object.keys(t.body.data.images)).toEqual(["photo"]);

    // The location may only change the price, and gets Head Office's suggestion if it leaves it blank.
    const locked = await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId: t.body.data.id, name: "Gum", values: { headline: "Cheap gum", price: "12 kr" } });
    expect([locked.status, locked.body.error.details[0]]).toEqual([400, { path: "headline", message: "Set by Head Office and can't be changed" }]);
    const inst = await api().post("/api/v1/template-instances").set(ctx.auth).send({ templateId: t.body.data.id, name: "Gum", values: {} });
    expect(inst.status).toBe(201);

    await templateRender({ instanceId: inst.body.data.id, companyId: ctx.company.id });
    const row = await prisma.templateInstance.findUniqueOrThrow({ where: { id: inst.body.data.id } });
    const png = await getObjectBuffer(row.outputKey!);
    // Head Office's red product image fills the right half.
    expect(await pixel(png, 1700, 540)).toEqual([255, 0, 0]);
  });

  it("refuses a fixed field without a value and an image that was never uploaded", async () => {
    const admin = await superAdminContext();
    const noValue = await api().post("/api/v1/templates").set(admin.auth).send({ name: "Gum", category: "Promotion", fields: [{ key: "headline", label: "Headline", type: "text", locked: true }] });
    expect(noValue.status).toBe(400);
    expect(noValue.body.error.details[0].message).toBe("Enter the value Head Office sets");
    const missing = await api().post("/api/v1/templates").set(admin.auth).send({ name: "Gum", category: "Promotion", fields: [{ key: "photo", label: "Photo", type: "image", locked: true, default: "head-office/templates/nope/gum.png" }] });
    expect([missing.status, missing.body.error.code]).toEqual([400, "TEMPLATE_IMAGE_MISSING"]);
    const foreign = await api().post("/api/v1/templates").set(admin.auth).send({ name: "Gum", category: "Promotion", fields: [{ key: "photo", label: "Photo", type: "image", locked: true, default: "some-company/photo.png" }] });
    expect(foreign.status).toBe(400);
    const ctx = await customerContext();
    expect((await api().post("/api/v1/templates/images/upload-url").set(ctx.auth).send({ fileName: "a.png", contentType: "image/png", sizeBytes: 10 })).status).toBe(403);
  });
});
