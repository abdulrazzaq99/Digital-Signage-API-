import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { createGroupBody, listScreensQuery, pairBody, remoteCommandBody, updateGroupBody, updateScreenBody } from "./screens.schemas.js";
import { screensService as service } from "./screens.service.js";

type P = { id: string };

export const screensController = {
  async list(req: Request, res: Response) {
    const { query } = input<unknown, z.infer<typeof listScreensQuery>>(req);
    const { data, meta } = await service.list(req.scope, query);
    ok(res, data, meta);
  },
  async get(req: Request, res: Response) {
    const { params } = input<unknown, unknown, P>(req);
    ok(res, await service.get(req.scope, params.id));
  },
  async pair(req: Request, res: Response) {
    const { body } = input<z.infer<typeof pairBody>>(req);
    created(res, await service.pair(req.user!, req.scope, body));
  },
  async update(req: Request, res: Response) {
    const { body, params } = input<z.infer<typeof updateScreenBody>, unknown, P>(req);
    ok(res, await service.update(req.user!, req.scope, params.id, body));
  },
  async unpair(req: Request, res: Response) {
    const { params } = input<unknown, unknown, P>(req);
    await service.unpair(req.user!, req.scope, params.id);
    noContent(res);
  },
  async command(req: Request, res: Response) {
    const { body, params } = input<z.infer<typeof remoteCommandBody>, unknown, P>(req);
    ok(res, await service.command(req.user!, req.scope, params.id, body), undefined, 202);
  },
  async listGroups(req: Request, res: Response) {
    ok(res, await service.listGroups(req.scope));
  },
  async getGroup(req: Request, res: Response) {
    const { params } = input<unknown, unknown, P>(req);
    ok(res, await service.getGroup(req.scope, params.id));
  },
  async createGroup(req: Request, res: Response) {
    const { body } = input<z.infer<typeof createGroupBody>>(req);
    created(res, await service.createGroup(req.user!, req.scope, body));
  },
  async updateGroup(req: Request, res: Response) {
    const { body, params } = input<z.infer<typeof updateGroupBody>, unknown, P>(req);
    ok(res, await service.updateGroup(req.user!, req.scope, params.id, body));
  },
  async deleteGroup(req: Request, res: Response) {
    const { params } = input<unknown, unknown, P>(req);
    await service.deleteGroup(req.user!, req.scope, params.id);
    noContent(res);
  },
};
