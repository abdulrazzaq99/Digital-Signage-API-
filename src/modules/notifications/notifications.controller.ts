import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { createNotificationBody, listNotificationsQuery, subscribeBody } from "./notifications.schemas.js";
import { notificationsService as service } from "./notifications.service.js";

export const notificationsController = {
  async list(req: Request, res: Response) { const { query } = input<unknown, z.infer<typeof listNotificationsQuery>>(req); const { data, meta } = await service.list(req.scope, query); ok(res, data, meta); },
  async create(req: Request, res: Response) { const { body } = input<z.infer<typeof createNotificationBody>>(req); ok(res, await service.create(req.user!, req.scope, body), undefined, 202); },
  async inbox(req: Request, res: Response) { const { query } = input<unknown, z.infer<typeof listNotificationsQuery>>(req); const { data, meta } = await service.inbox(req.user!, query); ok(res, data, meta); },
  async get(req: Request, res: Response) { const { params } = input<unknown, unknown, { id: string }>(req); ok(res, await service.get(req.user!, params.id)); },
  async subscribe(req: Request, res: Response) { const { body } = input<z.infer<typeof subscribeBody>>(req); created(res, await service.subscribe(req.user!, body)); },
  async unsubscribe(req: Request, res: Response) { const { params } = input<unknown, unknown, { id: string }>(req); await service.unsubscribe(req.user!, params.id); noContent(res); },
};
