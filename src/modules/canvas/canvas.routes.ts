import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { idempotency } from "../../core/middleware/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import { canvasController as c } from "./canvas.controller.js";
import { createCanvasBody, idParams, updateCanvasBody } from "./canvas.schemas.js";

const editors = ["ADMIN", "EDITOR"] as const;
export const canvasRouter = Router();
canvasRouter.use(authenticate());
canvasRouter.get("/", authorize(), asyncHandler(c.list));
canvasRouter.post("/", authorize({ roles: [...editors] }), validate({ body: createCanvasBody }), asyncHandler(c.create));
canvasRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.get));
canvasRouter.patch("/:id", authorize({ roles: [...editors] }), validate({ params: idParams, body: updateCanvasBody }), asyncHandler(c.update));
canvasRouter.post("/:id/activate", authorize({ roles: [...editors] }), idempotency(), validate({ params: idParams }), asyncHandler(c.activate));
canvasRouter.post("/:id/deactivate", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.deactivate));
canvasRouter.delete("/:id", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.remove));
