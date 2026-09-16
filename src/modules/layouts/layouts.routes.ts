import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { idempotency } from "../../core/middleware/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import { layoutsController as c } from "./layouts.controller.js";
import { bindZoneBody, createLayoutBody, idParams, publishBody, zoneParams } from "./layouts.schemas.js";

const editors = ["ADMIN", "EDITOR"] as const;

export const layoutsRouter = Router();
layoutsRouter.use(authenticate());
layoutsRouter.get("/presets", authorize(), asyncHandler(c.presets));
layoutsRouter.get("/", authorize(), asyncHandler(c.list));
layoutsRouter.post("/", authorize({ roles: [...editors] }), validate({ body: createLayoutBody }), asyncHandler(c.create));
layoutsRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.get));
layoutsRouter.put("/:id/zones/:index", authorize({ roles: [...editors] }), validate({ params: zoneParams, body: bindZoneBody }), asyncHandler(c.bindZone));
layoutsRouter.delete("/:id/zones/:index", authorize({ roles: [...editors] }), validate({ params: zoneParams }), asyncHandler(c.unbindZone));
layoutsRouter.delete("/:id", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.remove));
layoutsRouter.post("/:id/publish", authorize({ roles: [...editors] }), idempotency(), validate({ params: idParams, body: publishBody }), asyncHandler(c.publish));
