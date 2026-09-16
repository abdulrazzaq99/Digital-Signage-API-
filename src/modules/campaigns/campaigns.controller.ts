import type { Request, Response } from "express";
import type { z } from "zod";
import { IDEMPOTENCY_HEADER } from "../../config/constants.js";
import { ValidationError } from "../../core/errors/AppError.js";
import { created, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { addPrizeBody, createCampaignBody, listCampaignsQuery, listWinnersQuery, updateCampaignBody } from "./campaigns.schemas.js";
import { campaignsService as service } from "./campaigns.service.js";

type P = { id: string };
export const campaignsController = {
  async list(req: Request, res: Response) { const { query } = input<unknown, z.infer<typeof listCampaignsQuery>>(req); const { data, meta } = await service.list(req.scope, query); ok(res, data, meta); },
  async get(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.get(req.scope, params.id)); },
  async create(req: Request, res: Response) { const { body } = input<z.infer<typeof createCampaignBody>>(req); created(res, await service.create(req.user!, req.scope, body)); },
  async update(req: Request, res: Response) { const { body, params } = input<z.infer<typeof updateCampaignBody>, unknown, P>(req); ok(res, await service.update(req.user!, req.scope, params.id, body)); },
  async activate(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.setActive(req.user!, req.scope, params.id, true)); },
  async deactivate(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.setActive(req.user!, req.scope, params.id, false)); },
  async addPrize(req: Request, res: Response) { const { body, params } = input<z.infer<typeof addPrizeBody>, unknown, P>(req); created(res, await service.addPrize(req.user!, req.scope, params.id, body)); },
  async removePrize(req: Request, res: Response) { const { params } = input<unknown, unknown, { id: string; prizeId: string }>(req); ok(res, await service.removePrize(req.user!, req.scope, params.id, params.prizeId)); },
  async eligibility(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.eligibility(req.user!, params.id)); },
  async attempt(req: Request, res: Response) {
    const { params } = input<unknown, unknown, P>(req);
    const key = req.header(IDEMPOTENCY_HEADER);
    if (!key || key.length > 128) throw new ValidationError("Idempotency-Key header is required", undefined, "IDEMPOTENCY_KEY_REQUIRED");
    ok(res, await service.attempt(req.user!, params.id, key));
  },
  async listWinners(req: Request, res: Response) { const { query } = input<unknown, z.infer<typeof listWinnersQuery>>(req); const { data, meta } = await service.listWinners(req.scope, query); ok(res, data, meta); },
  async redeem(req: Request, res: Response) { const { params } = input<unknown, unknown, P>(req); ok(res, await service.redeem(req.user!, req.scope, params.id)); },
};
