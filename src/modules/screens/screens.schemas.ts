import { z } from "zod";
import { queryFlag } from "../../core/http/query.js";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { clearableField, clearableText, id, list, optionalField, optionalText, tags, text } from "../../core/validation/fields.js";

export const screenStatus = z.enum(["ONLINE", "OFFLINE", "ERROR"]);
export const orientation = z.enum(["LANDSCAPE", "PORTRAIT"]);
export const idParams = z.object({ id: id() });

export const listScreensQuery = paginationQuery.extend({
  search: optionalText(100),
  status: screenStatus.optional(),
  groupId: id().optional(),
  orientation: orientation.optional(),
  personal: queryFlag(),
});

export const pairBody = z.object({
  code: text(12, 4).regex(/^[A-Za-z0-9]+$/, "Enter the code shown on the screen").transform((s) => s.toUpperCase()),
  name: text(120, 2),
  location: optionalText(160),
  orientation: orientation.default("LANDSCAPE"),
  groupId: optionalField(id()),
  tags: tags().default([]),
}).openapi("PairScreenBody");

/** Blank or null clears `location`; blank or null `groupId` takes the screen out of its group. */
export const updateScreenBody = z.object({
  name: text(120, 2).optional(),
  location: clearableText(160),
  orientation: orientation.optional(),
  tags: tags().optional(),
  groupId: clearableField(id()),
}).openapi("UpdateScreenBody");

export const remoteCommandBody = z.object({ command: z.enum(["refresh", "restart_player"]) }).openapi("RemoteCommandBody");

const screenIds = list(id(), 500);
export const createGroupBody = z.object({ name: text(120, 2), description: optionalText(300), screenIds: screenIds.default([]) }).openapi("CreateGroupBody");
export const updateGroupBody = z.object({ name: text(120, 2).optional(), description: clearableText(300), screenIds: screenIds.optional() }).openapi("UpdateGroupBody");

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
