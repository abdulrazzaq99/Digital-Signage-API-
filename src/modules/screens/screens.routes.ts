import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { screensController as c } from "./screens.controller.js";
import { createGroupBody, idParams, listScreensQuery, pairBody, remoteCommandBody, updateGroupBody, updateScreenBody } from "./screens.schemas.js";

const editors = { roles: ["ADMIN", "EDITOR"] as const };

export const screensRouter = Router();
screensRouter.use(authenticate());
screensRouter.get("/", authorize(), validate({ query: listScreensQuery }), asyncHandler(c.list));
screensRouter.post("/pair", authorize({ roles: [...editors.roles] }), rateLimit({ name: "pair", limit: 20, windowSec: 60 }), validate({ body: pairBody }), asyncHandler(c.pair));
screensRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.get));
screensRouter.patch("/:id", authorize({ roles: [...editors.roles] }), validate({ params: idParams, body: updateScreenBody }), asyncHandler(c.update));
screensRouter.post("/:id/unpair", authorize({ roles: ["ADMIN"] }), validate({ params: idParams }), asyncHandler(c.unpair));
screensRouter.post("/:id/commands", authorize({ roles: [...editors.roles] }), validate({ params: idParams, body: remoteCommandBody }), asyncHandler(c.command));

export const groupsRouter = Router();
groupsRouter.use(authenticate());
groupsRouter.get("/", authorize(), asyncHandler(c.listGroups));
groupsRouter.post("/", authorize({ roles: [...editors.roles] }), validate({ body: createGroupBody }), asyncHandler(c.createGroup));
groupsRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.getGroup));
groupsRouter.patch("/:id", authorize({ roles: [...editors.roles] }), validate({ params: idParams, body: updateGroupBody }), asyncHandler(c.updateGroup));
groupsRouter.delete("/:id", authorize({ roles: [...editors.roles] }), validate({ params: idParams }), asyncHandler(c.deleteGroup));
