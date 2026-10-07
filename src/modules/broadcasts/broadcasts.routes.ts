import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { input, validate } from "../../core/middleware/validate.js";
import { broadcastUploadBody, createBroadcastBody, idParams, updateBroadcastBody } from "./broadcasts.schemas.js";
import { broadcastsService as service } from "./broadcasts.service.js";

type P = { id: string };

/** Head Office push: Super Admin only. */
export const broadcastsRouter = Router();
broadcastsRouter.use(authenticate(), authorize({ platformOnly: true }));
broadcastsRouter.get("/", asyncHandler(async (_req: Request, res: Response) => ok(res, await service.list())));
broadcastsRouter.post("/upload-url", validate({ body: broadcastUploadBody }), asyncHandler(async (req: Request, res: Response) => created(res, await service.uploadUrl(input<z.infer<typeof broadcastUploadBody>>(req).body))));
broadcastsRouter.post("/", validate({ body: createBroadcastBody }), asyncHandler(async (req: Request, res: Response) => created(res, await service.create(req.user!, input<z.infer<typeof createBroadcastBody>>(req).body))));
broadcastsRouter.patch("/:id", validate({ params: idParams, body: updateBroadcastBody }), asyncHandler(async (req: Request, res: Response) => {
  const { body, params } = input<z.infer<typeof updateBroadcastBody>, unknown, P>(req);
  ok(res, await service.update(req.user!, params.id, body));
}));
broadcastsRouter.delete("/:id", validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  await service.remove(req.user!, input<unknown, unknown, P>(req).params.id);
  noContent(res);
}));
