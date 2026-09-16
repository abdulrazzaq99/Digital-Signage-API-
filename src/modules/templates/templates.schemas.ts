import { z } from "zod";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { publishBody, publishResultDto } from "../playlists/playlists.schemas.js";

export const idParams = z.object({ id: z.string().min(1) });
export const templateField = z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80), type: z.enum(["text", "image", "color"]), required: z.boolean().default(false), max: z.number().int().positive().optional() });
export type TemplateField = z.infer<typeof templateField>;
export const createTemplateBody = z.object({ name: z.string().trim().min(2).max(120), category: z.string().trim().min(2).max(60), orientation: z.enum(["LANDSCAPE", "PORTRAIT"]).default("LANDSCAPE"), fields: z.array(templateField).min(1).max(20) }).openapi("CreateTemplateBody");
export const createInstanceBody = z.object({ templateId: z.string().min(1), name: z.string().trim().min(1).max(120), values: z.record(z.string(), z.string()) }).openapi("CreateTemplateInstanceBody");
export const updateInstanceBody = z.object({ name: z.string().trim().min(1).max(120).optional(), values: z.record(z.string(), z.string()).optional() }).openapi("UpdateTemplateInstanceBody");

export const templateDto = z.object({ id: z.string(), name: z.string(), category: z.string(), orientation: z.string(), fields: z.array(templateField), isGlobal: z.boolean(), usedIn: z.number(), createdAt: z.string() }).openapi("Template");
export const instanceDto = z.object({ id: z.string(), templateId: z.string(), templateName: z.string(), name: z.string(), values: z.record(z.string(), z.string()), outputUrl: z.string().nullable(), rendered: z.boolean(), createdAt: z.string(), updatedAt: z.string() }).openapi("TemplateInstance");

const tag = ["Templates"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/templates", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(templateDto))) } });
registry.registerPath({ method: "post", path: "/templates", tags: tag, security: sec, request: { body: jsonBody(createTemplateBody) }, responses: { 201: jsonBody(envelope(templateDto)), 403: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "delete", path: "/templates/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });
registry.registerPath({ method: "get", path: "/template-instances", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(instanceDto))) } });
registry.registerPath({ method: "post", path: "/template-instances", tags: tag, security: sec, request: { body: jsonBody(createInstanceBody) }, responses: { 201: jsonBody(envelope(instanceDto)), 400: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/template-instances/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(instanceDto)) } });
registry.registerPath({ method: "patch", path: "/template-instances/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateInstanceBody) }, responses: { 200: jsonBody(envelope(instanceDto)) } });
registry.registerPath({ method: "post", path: "/template-instances/{id}/render", tags: tag, security: sec, request: { params: idParams }, responses: { 202: jsonBody(envelope(instanceDto)) } });
registry.registerPath({ method: "post", path: "/template-instances/{id}/publish", tags: tag, security: sec, request: { params: idParams, body: jsonBody(publishBody), headers: z.object({ "idempotency-key": z.string() }) }, responses: { 200: jsonBody(envelope(publishResultDto)) } });
registry.registerPath({ method: "delete", path: "/template-instances/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });
