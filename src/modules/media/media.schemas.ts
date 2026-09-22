import { z } from "zod";
import { queryFlag } from "../../core/http/query.js";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from "../../config/constants.js";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const mediaType = z.enum(["IMAGE", "VIDEO", "PDF"]);
export const mediaStatus = z.enum(["UPLOADING", "PROCESSING", "READY", "FAILED"]);
export const idParams = z.object({ id: z.string().min(1) });
export const listMediaQuery = paginationQuery.extend({ search: z.string().trim().max(100).optional(), type: mediaType.optional(), status: mediaStatus.optional() });
export const uploadUrlBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(Object.keys(ALLOWED_MIME) as [keyof typeof ALLOWED_MIME, ...(keyof typeof ALLOWED_MIME)[]]),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
}).openapi("UploadUrlBody");
export const finalizeBody = z.object({ checksum: z.string().max(128).optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), durationSec: z.number().int().positive().optional(), pages: z.number().int().positive().optional() }).openapi("FinalizeUploadBody");
export const updateMediaBody = z.object({ name: z.string().trim().min(1).max(200).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).optional() }).openapi("UpdateMediaBody");
export const deleteQuery = z.object({ force: queryFlag(false) });

export const mediaDto = z.object({
  id: z.string(), name: z.string(), type: mediaType, status: mediaStatus, mimeType: z.string(), sizeBytes: z.number(), checksum: z.string().nullable(), width: z.number().nullable(), height: z.number().nullable(), durationSec: z.number().nullable(), pages: z.number().nullable(), tags: z.array(z.string()), failureReason: z.string().nullable(), uploadedBy: z.string().nullable(), createdAt: z.string(),
  usedIn: z.array(z.object({ id: z.string(), name: z.string(), kind: z.literal("PLAYLIST") })),
  thumbnailUrl: z.string().nullable(),
}).openapi("Media");

const tag = ["Media"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/media", tags: tag, security: sec, request: { query: listMediaQuery }, responses: { 200: jsonBody(envelope(z.array(mediaDto))) } });
const uploadUrlDto = z.object({ asset: mediaDto, uploadUrl: z.string(), expiresInSec: z.number() }).openapi("UploadUrl");
registry.registerPath({ method: "post", path: "/media/upload-url", tags: tag, security: sec, description: "Creates the asset and a presigned PUT URL. The lifetime grows with the file size (15 minutes to 6 hours).", request: { body: jsonBody(uploadUrlBody) }, responses: { 201: jsonBody(envelope(uploadUrlDto)), 400: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/media/{id}/upload-url", tags: tag, security: sec, description: "A fresh presigned PUT URL for an asset that is still UPLOADING or FAILED. Uploads left UPLOADING for 24 hours are deleted.", request: { params: idParams }, responses: { 200: jsonBody(envelope(uploadUrlDto)), 404: jsonBody(ErrorEnvelope), 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/media/{id}/finalize", tags: tag, security: sec, request: { params: idParams, body: jsonBody(finalizeBody) }, responses: { 200: jsonBody(envelope(mediaDto)), 400: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/media/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(mediaDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/media/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateMediaBody) }, responses: { 200: jsonBody(envelope(mediaDto)) } });
registry.registerPath({ method: "get", path: "/media/{id}/download-url", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(z.object({ url: z.string(), expiresInSec: z.number() }))) } });
registry.registerPath({ method: "post", path: "/media/{id}/retry", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(mediaDto)) } });
registry.registerPath({ method: "delete", path: "/media/{id}", tags: tag, security: sec, request: { params: idParams, query: deleteQuery }, responses: { 204: { description: "Deleted" }, 409: jsonBody(ErrorEnvelope) } });
