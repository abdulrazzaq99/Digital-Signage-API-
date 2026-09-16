import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { createUserBody, listUsersQuery, updateProfileBody, updateUserBody } from "./users.schemas.js";
import { usersService as service } from "./users.service.js";

export const usersController = {
  async list(req: Request, res: Response) {
    const { query } = input<unknown, z.infer<typeof listUsersQuery>>(req);
    const { data, meta } = await service.list(req.scope, query);
    ok(res, data, meta);
  },
  async create(req: Request, res: Response) {
    const { body } = input<z.infer<typeof createUserBody>>(req);
    created(res, await service.create(req.user!, req.scope, body));
  },
  async update(req: Request, res: Response) {
    const { body, params } = input<z.infer<typeof updateUserBody>, unknown, { id: string }>(req);
    ok(res, await service.update(req.user!, req.scope, params.id, body));
  },
  async remove(req: Request, res: Response) {
    const { params } = input<unknown, unknown, { id: string }>(req);
    await service.remove(req.user!, req.scope, params.id);
    noContent(res);
  },
  async updateProfile(req: Request, res: Response) {
    const { body } = input<z.infer<typeof updateProfileBody>>(req);
    ok(res, await service.updateProfile(req.user!, body));
  },
};
