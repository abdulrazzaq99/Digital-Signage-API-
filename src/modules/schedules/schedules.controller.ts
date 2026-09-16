import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { checkConflictsBody, createScheduleBody, listSchedulesQuery, updateScheduleBody } from "./schedules.schemas.js";
import { schedulesService as service } from "./schedules.service.js";

export const schedulesController = {
  async list(req: Request, res: Response) { const { query } = input<unknown, z.infer<typeof listSchedulesQuery>>(req); const { data, meta } = await service.list(req.scope, query); ok(res, data, meta); },
  async checkConflicts(req: Request, res: Response) { const { body } = input<z.infer<typeof checkConflictsBody>>(req); ok(res, await service.checkConflicts(req.scope, body)); },
  async active(req: Request, res: Response) { const { query } = input<unknown, { screenId: string; at?: string }>(req); ok(res, await service.active(req.scope, query.screenId, query.at)); },
  async create(req: Request, res: Response) { const { body } = input<z.infer<typeof createScheduleBody>>(req); created(res, await service.create(req.user!, req.scope, body)); },
  async update(req: Request, res: Response) { const { body, params } = input<z.infer<typeof updateScheduleBody>, unknown, { id: string }>(req); ok(res, await service.update(req.user!, req.scope, params.id, body)); },
  async remove(req: Request, res: Response) { const { params } = input<unknown, unknown, { id: string }>(req); await service.remove(req.user!, req.scope, params.id); noContent(res); },
};
