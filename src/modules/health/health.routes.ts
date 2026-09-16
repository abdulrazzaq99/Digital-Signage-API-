import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { getHealth } from "./health.controller.js";

export const healthRouter = Router();
healthRouter.get("/health", asyncHandler(getHealth));
