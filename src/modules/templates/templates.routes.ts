import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { idempotency } from "../../core/middleware/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import { publishBody } from "../playlists/playlists.schemas.js";
import { templatesController as c } from "./templates.controller.js";
import { createInstanceBody, createTemplateBody, idParams, updateInstanceBody } from "./templates.schemas.js";

const editors = ["ADMIN", "EDITOR"] as const;

export const templatesRouter = Router();
templatesRouter.use(authenticate());
templatesRouter.get("/", authorize(), asyncHandler(c.list));
templatesRouter.post("/", authorize({ platformOnly: true }), validate({ body: createTemplateBody }), asyncHandler(c.create));
templatesRouter.delete("/:id", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(c.remove));

export const templateInstancesRouter = Router();
templateInstancesRouter.use(authenticate());
templateInstancesRouter.get("/", authorize(), asyncHandler(c.listInstances));
templateInstancesRouter.post("/", authorize({ roles: [...editors] }), validate({ body: createInstanceBody }), asyncHandler(c.createInstance));
templateInstancesRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.getInstance));
templateInstancesRouter.patch("/:id", authorize({ roles: [...editors] }), validate({ params: idParams, body: updateInstanceBody }), asyncHandler(c.updateInstance));
templateInstancesRouter.post("/:id/render", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.render));
templateInstancesRouter.post("/:id/publish", authorize({ roles: [...editors] }), idempotency(), validate({ params: idParams, body: publishBody }), asyncHandler(c.publish));
templateInstancesRouter.delete("/:id", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.removeInstance));
