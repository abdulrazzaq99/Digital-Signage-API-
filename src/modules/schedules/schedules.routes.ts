import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { idempotency } from "../../core/middleware/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import { schedulesController as c } from "./schedules.controller.js";
import { activeQuery, checkConflictsBody, createScheduleBody, idParams, listSchedulesQuery, updateScheduleBody } from "./schedules.schemas.js";

const editors = ["ADMIN", "EDITOR"] as const;

export const schedulesRouter = Router();
schedulesRouter.use(authenticate());
schedulesRouter.get("/", authorize(), validate({ query: listSchedulesQuery }), asyncHandler(c.list));
schedulesRouter.get("/active", authorize(), validate({ query: activeQuery }), asyncHandler(c.active));
schedulesRouter.post("/check-conflicts", authorize(), validate({ body: checkConflictsBody }), asyncHandler(c.checkConflicts));
schedulesRouter.post("/", authorize({ roles: [...editors] }), idempotency(), validate({ body: createScheduleBody }), asyncHandler(c.create));
schedulesRouter.patch("/:id", authorize({ roles: [...editors] }), validate({ params: idParams, body: updateScheduleBody }), asyncHandler(c.update));
schedulesRouter.delete("/:id", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.remove));
