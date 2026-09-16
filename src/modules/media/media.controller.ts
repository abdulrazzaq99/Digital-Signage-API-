import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import type { finalizeBody, listMediaQuery, updateMediaBody, uploadUrlBody } from "./media.schemas.js";
import { mediaService as service } from "./media.service.js";

type P = { id: string };

export const mediaController = {
  async list(req: Request, res: Response) {
    const { query } = input<unknown, z.infer<typeof listMediaQuery>>(req);
    const { data, meta } = await service.list(req.scope, query);
    ok(res, data, meta);
  },
  async get(req: Request, res: Response) {
    const { params } = input<unknown, unknown, P>(req);
    ok(res, await service.get(req.scope, params.id));
  },
  async uploadUrl(req: Request, res: Response) {
    const { body } = input<z.infer<typeof uploadUrlBody>>(req);
    created(res, await service.createUploadUrl(req.user!, req.scope, body));
  },
  async finalize(req: Request, res: Response) {
    const { body, params } = input<z.infer<typeof finalizeBody>, unknown, P>(req);
    ok(res, await service.finalize(req.user!, req.scope, params.id, body));
  },
  async update(req: Request, res: Response) {
    const { body, params } = input<z.infer<typeof updateMediaBody>, unknown, P>(req);
    ok(res, await service.update(req.user!, req.scope, params.id, body));
  },
  async downloadUrl(req: Request, res: Response) {
    const { params } = input<unknown, unknown, P>(req);
    ok(res, await service.downloadUrl(req.scope, params.id));
  },
  async retry(req: Request, res: Response) {
    const { params } = input<unknown, unknown, P>(req);
    ok(res, await service.retry(req.user!, req.scope, params.id));
  },
  async remove(req: Request, res: Response) {
    const { params, query } = input<unknown, { force: boolean }, P>(req);
    await service.remove(req.user!, req.scope, params.id, query.force);
    noContent(res);
  },
};
