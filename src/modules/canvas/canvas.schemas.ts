import { z } from "zod";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const idParams = z.object({ id: z.string().min(1) });
export const createCanvasBody = z.object({ name: z.string().trim().min(2).max(120), screenIds: z.array(z.string()).min(2).max(16) }).openapi("CreateCanvasBody");
export const updateCanvasBody = z.object({ name: z.string().trim().min(2).max(120).optional(), screenIds: z.array(z.string()).min(2).max(16).optional(), content: z.object({ kind: z.enum(["PLAYLIST", "LAYOUT", "TEMPLATE_INSTANCE"]), refId: z.string().min(1) }).nullable().optional() }).openapi("UpdateCanvasBody");
export const memberDto = z.object({ screenId: z.string(), name: z.string(), location: z.string().nullable(), position: z.number(), status: z.string(), ready: z.boolean(), synced: z.boolean(), orientation: z.string() });
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
