import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { createOfferBody, listOffersQuery, updateOfferBody } from "./offers.schemas.js";
import { offersService as service } from "./offers.service.js";

type P = { id: string };
export const offersController = {
  async list(req: Request, res: Response) { const { query } = input<unknown, z.infer<typeof listOffersQuery>>(req); const { data, meta } = await service.list(req.scope, query); ok(res, data, meta); },
  async get(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.get(req.scope, params.id)); },
  async create(req: Request, res: Response) { const { body } = input<z.infer<typeof createOfferBody>>(req); created(res, await service.create(req.user!, req.scope, body)); },
  async update(req: Request, res: Response) { const { body, params } = input<z.infer<typeof updateOfferBody>, unknown, P>(req); ok(res, await service.update(req.user!, req.scope, params.id, body)); },
  async publish(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.setPublished(req.user!, req.scope, params.id, true)); },
  async unpublish(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.setPublished(req.user!, req.scope, params.id, false)); },
  async view(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.recordView(req.user!, req.scope, params.id), undefined, 202); },
  async stats(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.stats(req.scope, params.id)); },
  async remove(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); await service.remove(req.user!, req.scope, params.id); noContent(res); },
};
