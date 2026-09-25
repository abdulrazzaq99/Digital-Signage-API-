import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { id, int, list, optionalText, text } from "../../core/validation/fields.js";

export const idParams = z.object({ id: id() });
export const itemParams = z.object({ id: id(), itemId: id() });
export const listPlaylistsQuery = paginationQuery.extend({ search: optionalText(100), status: z.enum(["DRAFT", "PUBLISHED"]).optional() });
const durationSec = int(1, 86_400);
const page = int(1, 2000);
/** `page` picks one page of a PDF; without it a PDF item shows every page, each for `durationSec`. */
const itemInput = z.object({ assetId: id(), durationSec, page: page.optional() }).strict();
const items = list(itemInput, 500);
export const createPlaylistBody = z.object({ name: text(120), items: items.default([]) }).openapi("CreatePlaylistBody");
export const updatePlaylistBody = z.object({ name: text(120).optional(), items: items.optional() }).openapi("UpdatePlaylistBody");
export const addItemBody = z.object({ assetId: id(), durationSec: durationSec.optional(), page: page.optional(), position: int(0, 10_000).optional() }).openapi("AddPlaylistItemBody");
export const updateItemBody = z.object({ durationSec }).openapi("UpdatePlaylistItemBody");
export const reorderBody = z.object({ itemIds: list(id(), 1000, 1) }).openapi("ReorderPlaylistBody");
export const publishBody = z.object({ screenIds: list(id(), 500).default([]), groupIds: list(id(), 500).default([]) }).refine((b) => b.screenIds.length + b.groupIds.length > 0, "Select at least one screen or group").openapi("PublishPlaylistBody");

export const playlistItemDto = z.object({ id: z.string(), position: z.number(), durationSec: z.number(), page: z.number().nullable(), asset: z.object({ id: z.string(), name: z.string(), type: z.string(), status: z.string(), thumbnailUrl: z.string().nullable() }) }).openapi("PlaylistItem");
export const playlistDto = z.object({ id: z.string(), name: z.string(), status: z.string(), version: z.number(), itemCount: z.number(), totalDurationSec: z.number(), assignedTo: z.array(z.object({ id: z.string(), name: z.string() })), createdAt: z.string(), updatedAt: z.string(), items: z.array(playlistItemDto).optional() }).openapi("Playlist");
export const publishResultDto = z.object({ version: z.number(), screens: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), version: z.number() })) }).openapi("PublishResult");

const tag = ["Playlists"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/playlists", tags: tag, security: sec, request: { query: listPlaylistsQuery }, responses: { 200: jsonBody(envelope(z.array(playlistDto))) } });
registry.registerPath({ method: "post", path: "/playlists", tags: tag, security: sec, request: { body: jsonBody(createPlaylistBody) }, responses: { 201: jsonBody(envelope(playlistDto)) } });
registry.registerPath({ method: "get", path: "/playlists/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(playlistDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/playlists/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updatePlaylistBody) }, responses: { 200: jsonBody(envelope(playlistDto)) } });
registry.registerPath({ method: "delete", path: "/playlists/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" }, 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/playlists/{id}/duplicate", tags: tag, security: sec, request: { params: idParams }, responses: { 201: jsonBody(envelope(playlistDto)) } });
registry.registerPath({ method: "post", path: "/playlists/{id}/items", tags: tag, security: sec, request: { params: idParams, body: jsonBody(addItemBody) }, responses: { 201: jsonBody(envelope(playlistDto)) } });
registry.registerPath({ method: "patch", path: "/playlists/{id}/items/{itemId}", tags: tag, security: sec, request: { params: itemParams, body: jsonBody(updateItemBody) }, responses: { 200: jsonBody(envelope(playlistDto)) } });
registry.registerPath({ method: "delete", path: "/playlists/{id}/items/{itemId}", tags: tag, security: sec, request: { params: itemParams }, responses: { 200: jsonBody(envelope(playlistDto)) } });
registry.registerPath({ method: "put", path: "/playlists/{id}/reorder", tags: tag, security: sec, request: { params: idParams, body: jsonBody(reorderBody) }, responses: { 200: jsonBody(envelope(playlistDto)), 400: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/playlists/{id}/publish", tags: tag, security: sec, request: { params: idParams, body: jsonBody(publishBody), headers: z.object({ "idempotency-key": z.string() }) }, responses: { 200: jsonBody(envelope(publishResultDto)), 400: jsonBody(ErrorEnvelope), 403: jsonBody(ErrorEnvelope) } });
