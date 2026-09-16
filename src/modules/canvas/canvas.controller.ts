import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { createCanvasBody, updateCanvasBody } from "./canvas.schemas.js";
import { canvasService as service } from "./canvas.service.js";

type P = { id: string };
export const canvasController = {
  async list(req: Request, res: Response) { ok(res, await service.list(req.scope)); },
  async get(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.get(req.scope, params.id)); },
  async create(req: Request, res: Response) { const { body } = input<z.infer<typeof createCanvasBody>>(req); created(res, await service.create(req.user!, req.scope, body)); },
  async update(req: Request, res: Response) { const { body, params } = input<z.infer<typeof updateCanvasBody>, unknown, P>(req); ok(res, await service.update(req.user!, req.scope, params.id, body)); },
  async activate(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.activate(req.user!, req.scope, params.id)); },
  async deactivate(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.deactivate(req.user!, req.scope, params.id)); },
  async remove(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); await service.remove(req.user!, req.scope, params.id); noContent(res); },
};
