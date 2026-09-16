import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { bindZoneBody, createLayoutBody, publishBody } from "./layouts.schemas.js";
import { layoutsService as service } from "./layouts.service.js";

type P = { id: string };
type ZP = { id: string; index: number };

export const layoutsController = {
  async presets(_req: Request, res: Response) { ok(res, await service.presets()); },
  async list(req: Request, res: Response) { ok(res, await service.list(req.scope)); },
  async get(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.get(req.scope, params.id)); },
  async create(req: Request, res: Response) { const { body } = input<z.infer<typeof createLayoutBody>>(req); created(res, await service.create(req.user!, req.scope, body)); },
  async bindZone(req: Request, res: Response) { const { body, params } = input<z.infer<typeof bindZoneBody>, unknown, ZP>(req); ok(res, await service.bindZone(req.user!, req.scope, params.id, params.index, body)); },
  async unbindZone(req: Request, res: Response) { const { params } = input<unknown, unknown, ZP>(req); ok(res, await service.unbindZone(req.scope, params.id, params.index)); },
  async remove(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); await service.remove(req.user!, req.scope, params.id); noContent(res); },
  async publish(req: Request, res: Response) { const { body, params } = input<z.infer<typeof publishBody>, unknown, P>(req); ok(res, await service.publish(req.user!, req.scope, params.id, body)); },
};
