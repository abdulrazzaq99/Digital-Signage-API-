import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { publishBody } from "../playlists/playlists.schemas.js";
import type { createInstanceBody, createTemplateBody, updateInstanceBody } from "./templates.schemas.js";
import { templatesService as service } from "./templates.service.js";

type P = { id: string };

export const templatesController = {
  async list(_req: Request, res: Response) { ok(res, await service.list()); },
  async create(req: Request, res: Response) { const { body } = input<z.infer<typeof createTemplateBody>>(req); created(res, await service.create(req.user!, req.scope, body)); },
  async remove(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); await service.remove(req.user!, req.scope, params.id); noContent(res); },
  async listInstances(req: Request, res: Response) { ok(res, await service.listInstances(req.scope)); },
  async getInstance(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.getInstance(req.scope, params.id)); },
  async createInstance(req: Request, res: Response) { const { body } = input<z.infer<typeof createInstanceBody>>(req); created(res, await service.createInstance(req.user!, req.scope, body)); },
  async updateInstance(req: Request, res: Response) { const { body, params } = input<z.infer<typeof updateInstanceBody>, unknown, P>(req); ok(res, await service.updateInstance(req.user!, req.scope, params.id, body)); },
  async render(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.render(req.scope, params.id), undefined, 202); },
  async publish(req: Request, res: Response) { const { body, params } = input<z.infer<typeof publishBody>, unknown, P>(req); ok(res, await service.publish(req.user!, req.scope, params.id, body)); },
  async removeInstance(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); await service.removeInstance(req.user!, req.scope, params.id); noContent(res); },
};
