import { z } from "zod";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { publishBody, publishResultDto } from "../playlists/playlists.schemas.js";

export const idParams = z.object({ id: z.string().min(1) });
export const zoneParams = z.object({ id: z.string().min(1), index: z.coerce.number().int().min(0) });
export const createLayoutBody = z.object({ presetId: z.string().min(1), name: z.string().trim().min(1).max(120) }).openapi("CreateLayoutBody");
export const bindZoneBody = z.object({ bindingKind: z.enum(["MEDIA", "PLAYLIST"]), refId: z.string().min(1) }).openapi("BindZoneBody");
export const zoneDto = z.object({ index: z.number(), name: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), bindingKind: z.string().nullable(), binding: z.object({ id: z.string(), name: z.string() }).nullable() }).openapi("LayoutZone");
export const layoutDto = z.object({ id: z.string(), presetId: z.string(), name: z.string(), isPreset: z.boolean(), zones: z.array(zoneDto), ready: z.boolean(), createdAt: z.string() }).openapi("Layout");
export { publishBody, publishResultDto };

const tag = ["Layouts"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/layouts/presets", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(layoutDto))) } });
registry.registerPath({ method: "get", path: "/layouts", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(layoutDto))) } });
registry.registerPath({ method: "post", path: "/layouts", tags: tag, security: sec, request: { body: jsonBody(createLayoutBody) }, responses: { 201: jsonBody(envelope(layoutDto)) } });
registry.registerPath({ method: "get", path: "/layouts/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(layoutDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "put", path: "/layouts/{id}/zones/{index}", tags: tag, security: sec, request: { params: zoneParams, body: jsonBody(bindZoneBody) }, responses: { 200: jsonBody(envelope(layoutDto)) } });
registry.registerPath({ method: "delete", path: "/layouts/{id}/zones/{index}", tags: tag, security: sec, request: { params: zoneParams }, responses: { 200: jsonBody(envelope(layoutDto)) } });
registry.registerPath({ method: "delete", path: "/layouts/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });
registry.registerPath({ method: "post", path: "/layouts/{id}/publish", tags: tag, security: sec, request: { params: idParams, body: jsonBody(publishBody), headers: z.object({ "idempotency-key": z.string() }) }, responses: { 200: jsonBody(envelope(publishResultDto)), 400: jsonBody(ErrorEnvelope) } });
