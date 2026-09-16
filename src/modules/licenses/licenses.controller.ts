import type { Request, Response } from "express";
import type { z } from "zod";
import { ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { updateLicenseBody } from "./licenses.schemas.js";
import { licensesService as service } from "./licenses.service.js";

export const licensesController = {
  async listAll(req: Request, res: Response) {
    service.assertPlatform(req.scope);
    ok(res, await service.listAll());
  },
  async get(req: Request, res: Response) {
    const { params } = input<unknown, unknown, { companyId: string }>(req);
    ok(res, await service.get(req.scope, params.companyId));
  },
  async update(req: Request, res: Response) {
    const { body, params } = input<z.infer<typeof updateLicenseBody>, unknown, { companyId: string }>(req);
    ok(res, await service.update(req.user!, params.companyId, body));
  },
};
