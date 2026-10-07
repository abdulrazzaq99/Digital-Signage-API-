import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "../../config/constants.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { targetAudience, targetAudienceInput } from "../../core/targeting/audience.js";
import { dateTime, endAfterStart, id, int, text } from "../../core/validation/fields.js";

export const BROADCAST_PREFIX = "head-office/broadcasts/";
export const BROADCAST_MIME = { "image/png": "IMAGE", "image/jpeg": "IMAGE", "video/mp4": "VIDEO" } as const;

export const idParams = z.object({ id: id() });
export const broadcastUploadBody = z.object({ fileName: text(200), contentType: z.enum(["image/png", "image/jpeg", "video/mp4"]), sizeBytes: int(1, MAX_UPLOAD_BYTES) }).strict().openapi("BroadcastUploadBody");
export const broadcastUploadDto = z.object({ key: z.string(), uploadUrl: z.string(), expiresInSec: z.number() }).openapi("BroadcastUpload");

/** A push is made from a file Head Office uploaded (`fileKey`) or from a template (`templateId`). */
export const createBroadcastBody = z
  .object({
    title: text(120, 2),
    fileKey: text(400).optional(),
    templateId: id().optional(),
    /** A video's length in seconds, read by the browser; videos play to the end. */
    videoSec: int(1, 3600).optional(),
    width: int(1, 16_384).optional(),
    height: int(1, 16_384).optional(),
    /** How long a picture stays on screen each time. */
    displaySec: int(3, 600).default(10),
    audience: targetAudienceInput.default({ kind: "all" }),
    startsAt: dateTime().optional(),
    endsAt: dateTime().nullable().optional(),
  })
  .strict()
  .refine((b) => !!b.fileKey !== !!b.templateId, { message: "Upload a file or choose a template", path: ["fileKey"] })
  .superRefine(endAfterStart("startsAt", "endsAt"))
  .openapi("CreateBroadcastBody");
export const updateBroadcastBody = z
  .object({ title: text(120, 2).optional(), displaySec: int(3, 600).optional(), audience: targetAudienceInput.optional(), startsAt: dateTime().optional(), endsAt: dateTime().nullable().optional(), active: z.boolean().optional() })
  .strict()
  .superRefine(endAfterStart("startsAt", "endsAt"))
  .openapi("UpdateBroadcastBody");

export const broadcastStatus = z.enum(["LIVE", "SCHEDULED", "ENDED", "PAUSED"]);
export const broadcastDto = z.object({
  id: z.string(), title: z.string(), source: z.enum(["UPLOAD", "TEMPLATE"]), templateId: z.string().nullable(), type: z.enum(["IMAGE", "VIDEO"]), mimeType: z.string(), previewUrl: z.string(),
  displaySec: z.number(), audience: targetAudience, startsAt: z.string(), endsAt: z.string().nullable(), active: z.boolean(), status: broadcastStatus,
  /** Paired screens at the locations it is aimed at. */
  screens: z.number(), createdAt: z.string(),
}).openapi("Broadcast");

const tag = ["Head Office push"];
const sec = [{ bearerAuth: [] }];
const desc = "Super Admin only.";
registry.registerPath({ method: "get", path: "/broadcasts", tags: tag, security: sec, description: desc, responses: { 200: jsonBody(envelope(z.array(broadcastDto))) } });
registry.registerPath({ method: "post", path: "/broadcasts/upload-url", tags: tag, security: sec, description: `${desc} A presigned PUT for a picture or MP4 video to push.`, request: { body: jsonBody(broadcastUploadBody) }, responses: { 201: jsonBody(envelope(broadcastUploadDto)) } });
registry.registerPath({ method: "post", path: "/broadcasts", tags: tag, security: sec, description: `${desc} Pushes a file or a template to the chosen locations' screens.`, request: { body: jsonBody(createBroadcastBody) }, responses: { 201: jsonBody(envelope(broadcastDto)), 400: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/broadcasts/{id}", tags: tag, security: sec, description: `${desc} Changes the title, seconds, audience or dates, or pauses (active: false) and resumes it.`, request: { params: idParams, body: jsonBody(updateBroadcastBody) }, responses: { 200: jsonBody(envelope(broadcastDto)) } });
registry.registerPath({ method: "delete", path: "/broadcasts/{id}", tags: tag, security: sec, description: `${desc} Takes it off every screen and deletes it.`, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });
