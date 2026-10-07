import { Router, type Request, type Response } from "express";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { input, validate } from "../../core/middleware/validate.js";
import { categoryBody, idParams } from "./categories.schemas.js";
import { categoriesService as service } from "./categories.service.js";

type Body = { name: string };

export const categoriesRouter = Router();
categoriesRouter.use(authenticate());
categoriesRouter.get("/", authorize(), asyncHandler(async (_req: Request, res: Response) => ok(res, await service.list())));
categoriesRouter.post("/", authorize({ platformOnly: true }), validate({ body: categoryBody }), asyncHandler(async (req: Request, res: Response) => created(res, await service.create(req.user!, input<Body>(req).body))));
categoriesRouter.patch("/:id", authorize({ platformOnly: true }), validate({ params: idParams, body: categoryBody }), asyncHandler(async (req: Request, res: Response) => {
  const { body, params } = input<Body, unknown, { id: string }>(req);
  ok(res, await service.rename(req.user!, params.id, body));
}));
categoriesRouter.delete("/:id", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  await service.remove(req.user!, input<unknown, unknown, { id: string }>(req).params.id);
  noContent(res);
}));
