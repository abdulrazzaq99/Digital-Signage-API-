import type { Request, Response } from "express";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { z } from "zod";
import type { createCompanyBody, listCompaniesQuery, updateCompanyBody } from "./companies.schemas.js";
import { companiesService as service } from "./companies.service.js";

export const companiesController = {
  async list(req: Request, res: Response) {
    const { query } = input<unknown, z.infer<typeof listCompaniesQuery>>(req);
    const { data, meta } = await service.list(req.scope, query);
    ok(res, data, meta);
  },
  async get(req: Request, res: Response) {
    const { params } = input<unknown, unknown, { id: string }>(req);
    ok(res, await service.get(req.scope, params.id));
  },
  async create(req: Request, res: Response) {
    const { body } = input<z.infer<typeof createCompanyBody>>(req);
    created(res, await service.create(req.user!, body));
  },
  async update(req: Request, res: Response) {
    const { body, params } = input<z.infer<typeof updateCompanyBody>, unknown, { id: string }>(req);
    ok(res, await service.update(req.user!, req.scope, params.id, body));
  },
  async remove(req: Request, res: Response) {
    const { params } = input<unknown, unknown, { id: string }>(req);
    await service.remove(req.user!, params.id);
    noContent(res);
  },
};
