import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const idParams = z.object({ id: z.string().min(1) });
export const itemParams = z.object({ id: z.string().min(1), itemId: z.string().min(1) });
export const listPlaylistsQuery = paginationQuery.extend({ search: z.string().trim().max(100).optional(), status: z.enum(["DRAFT", "PUBLISHED"]).optional() });
export const createPlaylistBody = z.object({ name: z.string().trim().min(1).max(120), items: z.array(z.object({ assetId: z.string(), durationSec: z.number().int().min(1).max(3600) })).max(200).default([]) }).openapi("CreatePlaylistBody");
export const updatePlaylistBody = z.object({ name: z.string().trim().min(1).max(120).optional(), items: z.array(z.object({ assetId: z.string(), durationSec: z.number().int().min(1).max(3600) })).max(200).optional() }).openapi("UpdatePlaylistBody");
export const addItemBody = z.object({ assetId: z.string(), durationSec: z.number().int().min(1).max(3600).optional(), position: z.number().int().min(0).optional() }).openapi("AddPlaylistItemBody");
export const updateItemBody = z.object({ durationSec: z.number().int().min(1).max(3600) }).openapi("UpdatePlaylistItemBody");
export const reorderBody = z.object({ itemIds: z.array(z.string()).min(1) }).openapi("ReorderPlaylistBody");
export const publishBody = z.object({ screenIds: z.array(z.string()).default([]), groupIds: z.array(z.string()).default([]) }).refine((b) => b.screenIds.length + b.groupIds.length > 0, "Select at least one screen or group").openapi("PublishPlaylistBody");

export const playlistItemDto = z.object({ id: z.string(), position: z.number(), durationSec: z.number(), asset: z.object({ id: z.string(), name: z.string(), type: z.string(), status: z.string(), thumbnailUrl: z.string().nullable() }) }).openapi("PlaylistItem");
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
