import { z } from "zod";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { targetAudience, targetAudienceInput } from "../../core/targeting/audience.js";
import { hexColour, id, int, list, slug, text } from "../../core/validation/fields.js";
import { publishBody, publishResultDto } from "../playlists/playlists.schemas.js";

export const idParams = z.object({ id: id() });
const fraction = z.number().min(0).max(1);
/**
 * A customer-editable field. The optional layout keys are the designer's deliverable (spec 10.1):
 * where the field sits (`box`, fractions of the canvas), text size (`fontSize`, fraction of the
 * height), weight, alignment and colour, and how an image fills its box (`fit`). Fields without a
 * box are placed by the default layout. For an `image` field the value is a media asset ID.
 */
export const templateField = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "image", "color"]),
  required: z.boolean().default(false),
  max: z.number().int().positive().optional(),
  box: z.object({ x: fraction, y: fraction, w: fraction.refine((v) => v > 0), h: fraction.refine((v) => v > 0) }).optional(),
  fontSize: z.number().positive().max(0.5).optional(),
  weight: z.enum(["regular", "bold"]).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fit: z.enum(["cover", "contain"]).optional(),
  /** Set by Head Office: locations can't change it and always show `default`. */
  locked: z.boolean().default(false),
  /** Head Office's value: fixed when `locked`, otherwise used until the location fills its own. For an image, a Head Office image key. */
  default: z.string().max(2000).optional(),
});
/** Where Head Office's own template images are stored. */
export const HQ_IMAGE_PREFIX = "head-office/templates/";
/** Request form of `templateField`: slug keys, bounded text, and #rrggbb colours. */
const templateFieldInput = z
  .object({
    key: slug(40),
    label: text(80),
    type: z.enum(["text", "image", "color"]),
    required: z.boolean().default(false),
    max: int(1, 2000).optional(),
    box: z.object({ x: fraction, y: fraction, w: fraction.refine((v) => v > 0, "Must be above 0"), h: fraction.refine((v) => v > 0, "Must be above 0") }).strict().optional(),
    fontSize: z.number().positive().max(0.5).optional(),
    weight: z.enum(["regular", "bold"]).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    color: hexColour().optional(),
    fit: z.enum(["cover", "contain"]).optional(),
    locked: z.boolean().default(false),
    default: z.string().trim().max(2000, "Must be at most 2000 characters").optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const d = f.default ?? "";
    if (f.locked && !d) ctx.addIssue({ code: "custom", path: ["default"], message: f.type === "image" ? "Upload the image Head Office sets" : "Enter the value Head Office sets" });
    if (!d) return;
    if (f.type === "color" && !/^#[0-9a-fA-F]{6}$/.test(d)) ctx.addIssue({ code: "custom", path: ["default"], message: "Use a colour like #2563EB" });
    if (f.type === "text" && f.max && d.length > f.max) ctx.addIssue({ code: "custom", path: ["default"], message: `Must be at most ${f.max} characters` });
    if (f.type === "image" && !d.startsWith(HQ_IMAGE_PREFIX)) ctx.addIssue({ code: "custom", path: ["default"], message: "Upload the image for this template" });
  });
/** Instance values keyed by field key: at most 50 keys, each value up to 2000 characters. */
const templateValues = z.record(slug(60), z.string().trim().max(2000, "Must be at most 2000 characters")).refine((v) => Object.keys(v).length <= 50, "At most 50 values");

export type TemplateField = z.infer<typeof templateField>;
export const createTemplateBody = z
  .object({ name: text(120, 2), category: text(60, 2), orientation: z.enum(["LANDSCAPE", "PORTRAIT"]).default("LANDSCAPE"), fields: list(templateFieldInput, 20, 1), audience: targetAudienceInput.default({ kind: "all" }) })
  .openapi("CreateTemplateBody");
/** A Head Office image for a template field: PNG or JPEG up to 20 MB. */
export const templateImageUploadBody = z.object({ fileName: text(200), contentType: z.enum(["image/png", "image/jpeg"]), sizeBytes: int(1, 20 * 1024 * 1024) }).strict().openapi("TemplateImageUploadBody");
export const templateImageUploadDto = z.object({ key: z.string(), uploadUrl: z.string(), previewUrl: z.string(), expiresInSec: z.number() }).openapi("TemplateImageUpload");
/** Who may use the template; locations already using it keep their copies. */
export const updateTemplateBody = z.object({ audience: targetAudienceInput }).strict().openapi("UpdateTemplateBody");
export const createInstanceBody = z.object({ templateId: id(), name: text(120), values: templateValues }).openapi("CreateTemplateInstanceBody");
export const updateInstanceBody = z.object({ name: text(120).optional(), values: templateValues.optional() }).openapi("UpdateTemplateInstanceBody");

export const templateDto = z.object({ id: z.string(), name: z.string(), category: z.string(), orientation: z.string(), fields: z.array(templateField), isGlobal: z.boolean(), usedIn: z.number(), createdAt: z.string(), audience: targetAudience.optional(), images: z.record(z.string(), z.string()).describe("Field key → preview URL of Head Office's image for it") }).openapi("Template");
export const instanceDto = z.object({ id: z.string(), templateId: z.string(), templateName: z.string(), name: z.string(), values: z.record(z.string(), z.string()), outputUrl: z.string().nullable(), rendered: z.boolean(), rendering: z.boolean(), createdAt: z.string(), updatedAt: z.string() }).openapi("TemplateInstance");

const tag = ["Templates"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/templates", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(templateDto))) } });
registry.registerPath({ method: "post", path: "/templates", tags: tag, security: sec, request: { body: jsonBody(createTemplateBody) }, responses: { 201: jsonBody(envelope(templateDto)), 403: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/templates/images/upload-url", tags: tag, security: sec, description: "Super Admin only. A presigned PUT for a Head Office image to set on a template field (`default`).", request: { body: jsonBody(templateImageUploadBody) }, responses: { 201: jsonBody(envelope(templateImageUploadDto)) } });
registry.registerPath({ method: "patch", path: "/templates/{id}", tags: tag, security: sec, description: "Super Admin only. Changes which locations can use the template.", request: { params: idParams, body: jsonBody(updateTemplateBody) }, responses: { 200: jsonBody(envelope(templateDto)) } });
registry.registerPath({ method: "delete", path: "/templates/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });
registry.registerPath({ method: "get", path: "/template-instances", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(instanceDto))) } });
registry.registerPath({ method: "post", path: "/template-instances", tags: tag, security: sec, request: { body: jsonBody(createInstanceBody) }, responses: { 201: jsonBody(envelope(instanceDto)), 400: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/template-instances/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(instanceDto)) } });
registry.registerPath({ method: "patch", path: "/template-instances/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateInstanceBody) }, responses: { 200: jsonBody(envelope(instanceDto)) } });
registry.registerPath({ method: "post", path: "/template-instances/{id}/render", tags: tag, security: sec, request: { params: idParams }, responses: { 202: jsonBody(envelope(instanceDto)) } });
registry.registerPath({ method: "post", path: "/template-instances/{id}/publish", tags: tag, security: sec, request: { params: idParams, body: jsonBody(publishBody), headers: z.object({ "idempotency-key": z.string() }) }, responses: { 200: jsonBody(envelope(publishResultDto)) } });
registry.registerPath({ method: "delete", path: "/template-instances/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });
