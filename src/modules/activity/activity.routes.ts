import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import { ok } from "../../core/http/envelope.js";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { input, validate } from "../../core/middleware/validate.js";
import { listActivityQuery } from "./activity.schemas.js";
import { activityService } from "./activity.service.js";

async function list(req: Request, res: Response) {
  const { query } = input<unknown, z.infer<typeof listActivityQuery>>(req);
  const { data, meta } = await activityService.list(req.scope, query);
  ok(res, data, meta);
}

export const activityRouter = Router();
activityRouter.use(authenticate());
activityRouter.get("/", authorize(), validate({ query: listActivityQuery }), asyncHandler(list));
