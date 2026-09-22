import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const screenStatus = z.enum(["ONLINE", "OFFLINE", "ERROR"]);
export const orientation = z.enum(["LANDSCAPE", "PORTRAIT"]);
export const idParams = z.object({ id: z.string().min(1) });

export const listScreensQuery = paginationQuery.extend({
  search: z.string().trim().max(100).optional(),
  status: screenStatus.optional(),
  groupId: z.string().optional(),
  orientation: orientation.optional(),
  personal: z.stringbool().optional(),
});

export const pairBody = z.object({
  code: z.string().trim().min(4).max(12).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  location: z.string().trim().max(160).optional(),
  orientation: orientation.default("LANDSCAPE"),
  groupId: z.string().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
}).openapi("PairScreenBody");

export const updateScreenBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  location: z.string().trim().max(160).nullable().optional(),
  orientation: orientation.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  groupId: z.string().nullable().optional(),
}).openapi("UpdateScreenBody");

export const remoteCommandBody = z.object({ command: z.enum(["refresh", "restart_player"]) }).openapi("RemoteCommandBody");

export const createGroupBody = z.object({ name: z.string().trim().min(2).max(120), description: z.string().max(300).optional(), screenIds: z.array(z.string()).default([]) }).openapi("CreateGroupBody");
export const updateGroupBody = z.object({ name: z.string().trim().min(2).max(120).optional(), description: z.string().max(300).nullable().optional(), screenIds: z.array(z.string()).optional() }).openapi("UpdateGroupBody");

export const screenDto = z.object({
  id: z.string(), companyId: z.string(), name: z.string(), location: z.string().nullable(), orientation, status: screenStatus, syncState: z.string(), tags: z.array(z.string()), isPersonal: z.boolean(),
  lastSeenAt: z.string().nullable(), manifestVersion: z.number(), ackVersion: z.number(), createdAt: z.string(),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
  device: z.object({ deviceId: z.string(), model: z.string().nullable(), playerVersion: z.string().nullable(), appVersion: z.string().nullable(), firmware: z.string().nullable(), resolution: z.string().nullable(), ip: z.string().nullable() }).nullable(),
  assignment: z.object({ kind: z.string(), refId: z.string(), version: z.number(), publishedAt: z.string(), name: z.string(), thumbnailUrl: z.string().nullable() }).nullable(),
}).openapi("Screen");

export const groupDto = z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), screenCount: z.number(), onlineCount: z.number(), screenIds: z.array(z.string()), createdAt: z.string() }).openapi("ScreenGroup");

const tag = ["Screens"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/screens", tags: tag, security: sec, request: { query: listScreensQuery }, responses: { 200: jsonBody(envelope(z.array(screenDto))) } });
registry.registerPath({ method: "post", path: "/screens/pair", tags: tag, security: sec, request: { body: jsonBody(pairBody) }, responses: { 201: jsonBody(envelope(screenDto)), 404: jsonBody(ErrorEnvelope), 409: jsonBody(ErrorEnvelope), 410: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/screens/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(screenDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/screens/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateScreenBody) }, responses: { 200: jsonBody(envelope(screenDto)) } });
registry.registerPath({ method: "post", path: "/screens/{id}/unpair", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Unpaired; license slot released" } } });
registry.registerPath({ method: "post", path: "/screens/{id}/commands", tags: tag, security: sec, request: { params: idParams, body: jsonBody(remoteCommandBody) }, responses: { 202: { description: "Command dispatched" } } });
registry.registerPath({ method: "get", path: "/screen-groups", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(groupDto))) } });
registry.registerPath({ method: "post", path: "/screen-groups", tags: tag, security: sec, request: { body: jsonBody(createGroupBody) }, responses: { 201: jsonBody(envelope(groupDto)) } });
registry.registerPath({ method: "get", path: "/screen-groups/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(groupDto)) } });
registry.registerPath({ method: "patch", path: "/screen-groups/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateGroupBody) }, responses: { 200: jsonBody(envelope(groupDto)) } });
registry.registerPath({ method: "delete", path: "/screen-groups/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted; screens are kept" } } });
