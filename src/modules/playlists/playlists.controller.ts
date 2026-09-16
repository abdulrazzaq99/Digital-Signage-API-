import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { addItemBody, createPlaylistBody, listPlaylistsQuery, publishBody, reorderBody, updateItemBody, updatePlaylistBody } from "./playlists.schemas.js";
import { playlistsService as service } from "./playlists.service.js";

type P = { id: string };
type IP = { id: string; itemId: string };

export const playlistsController = {
  async list(req: Request, res: Response) { const { query } = input<unknown, z.infer<typeof listPlaylistsQuery>>(req); const { data, meta } = await service.list(req.scope, query); ok(res, data, meta); },
  async get(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.get(req.scope, params.id)); },
  async create(req: Request, res: Response) { const { body } = input<z.infer<typeof createPlaylistBody>>(req); created(res, await service.create(req.user!, req.scope, body)); },
  async update(req: Request, res: Response) { const { body, params } = input<z.infer<typeof updatePlaylistBody>, unknown, P>(req); ok(res, await service.update(req.user!, req.scope, params.id, body)); },
  async remove(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); await service.remove(req.user!, req.scope, params.id); noContent(res); },
  async duplicate(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); created(res, await service.duplicate(req.user!, req.scope, params.id)); },
  async addItem(req: Request, res: Response) { const { body, params } = input<z.infer<typeof addItemBody>, unknown, P>(req); created(res, await service.addItem(req.user!, req.scope, params.id, body)); },
  async updateItem(req: Request, res: Response) { const { body, params } = input<z.infer<typeof updateItemBody>, unknown, IP>(req); ok(res, await service.updateItem(req.user!, req.scope, params.id, params.itemId, body)); },
  async removeItem(req: Request, res: Response) { const { params } = input<unknown, unknown, IP>(req); ok(res, await service.removeItem(req.user!, req.scope, params.id, params.itemId)); },
  async reorder(req: Request, res: Response) { const { body, params } = input<z.infer<typeof reorderBody>, unknown, P>(req); ok(res, await service.reorder(req.user!, req.scope, params.id, body)); },
  async publish(req: Request, res: Response) { const { body, params } = input<z.infer<typeof publishBody>, unknown, P>(req); ok(res, await service.publish(req.user!, req.scope, params.id, body)); },
};
