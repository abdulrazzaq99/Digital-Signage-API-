import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { validate } from "../../core/middleware/validate.js";
import { licensesController as c } from "./licenses.controller.js";
import { companyIdParams, updateLicenseBody } from "./licenses.schemas.js";

/** Mounted at /licenses (platform list) and at /companies/:companyId/license. */
export const licensesRouter = Router();
licensesRouter.use(authenticate());
licensesRouter.get("/", authorize({ platformOnly: true }), asyncHandler(c.listAll));

export const companyLicenseRouter = Router({ mergeParams: true });
companyLicenseRouter.use(authenticate());
companyLicenseRouter.get("/", authorize(), validate({ params: companyIdParams }), asyncHandler(c.get));
companyLicenseRouter.put("/", authorize({ platformOnly: true }), validate({ params: companyIdParams, body: updateLicenseBody }), asyncHandler(c.update));
