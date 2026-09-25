import { z } from "zod";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { id, list, text } from "../../core/validation/fields.js";

export const idParams = z.object({ id: id() });
/** A canvas spans 2-16 screens. */
const canvasScreens = list(id(), 16, 2);
export const createCanvasBody = z.object({ name: text(120, 2), screenIds: canvasScreens }).openapi("CreateCanvasBody");
export const updateCanvasBody = z.object({ name: text(120, 2).optional(), screenIds: canvasScreens.optional(), content: z.object({ kind: z.enum(["PLAYLIST", "LAYOUT", "TEMPLATE_INSTANCE"]), refId: id() }).strict().nullable().optional() }).openapi("UpdateCanvasBody");

/** `ready`: online before activation; online and preloaded (acknowledged the current version) once active. */
export const memberDto = z.object({ screenId: z.string(), name: z.string(), location: z.string().nullable(), position: z.number(), status: z.string(), online: z.boolean(), preloaded: z.boolean(), ready: z.boolean(), synced: z.boolean(), orientation: z.string() });
export const canvasDto = z.object({ id: z.string(), name: z.string(), status: z.enum(["DRAFT", "ACTIVE", "DEGRADED", "INACTIVE"]), members: z.array(memberDto), readyCount: z.number(), content: z.object({ kind: z.string(), refId: z.string() }).nullable(), activateAt: z.string().nullable(), createdAt: z.string() }).openapi("CanvasSet");

const tag = ["Canvas"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/canvas", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(canvasDto))) } });
registry.registerPath({ method: "post", path: "/canvas", tags: tag, security: sec, request: { body: jsonBody(createCanvasBody) }, responses: { 201: jsonBody(envelope(canvasDto)), 400: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/canvas/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(canvasDto)) } });
registry.registerPath({ method: "patch", path: "/canvas/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateCanvasBody) }, responses: { 200: jsonBody(envelope(canvasDto)) } });
registry.registerPath({ method: "post", path: "/canvas/{id}/activate", tags: tag, security: sec, request: { params: idParams, headers: z.object({ "idempotency-key": z.string() }) }, responses: { 200: jsonBody(envelope(canvasDto)), 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/canvas/{id}/deactivate", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(canvasDto)) } });
registry.registerPath({ method: "delete", path: "/canvas/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });
