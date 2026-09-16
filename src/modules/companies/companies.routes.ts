import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { validate } from "../../core/middleware/validate.js";
import { companiesController as c } from "./companies.controller.js";
import { companyIdParams, createCompanyBody, listCompaniesQuery, updateCompanyBody } from "./companies.schemas.js";

export const companiesRouter = Router();
companiesRouter.use(authenticate());

companiesRouter.get("/", authorize({ platformOnly: true }), validate({ query: listCompaniesQuery }), asyncHandler(c.list));
companiesRouter.post("/", authorize({ platformOnly: true }), validate({ body: createCompanyBody }), asyncHandler(c.create));
companiesRouter.get("/:id", authorize(), validate({ params: companyIdParams }), asyncHandler(c.get));
companiesRouter.get("/:id/summary", authorize(), validate({ params: companyIdParams }), asyncHandler(c.get));
companiesRouter.patch("/:id", authorize({ roles: ["ADMIN"] }), validate({ params: companyIdParams, body: updateCompanyBody }), asyncHandler(c.update));
companiesRouter.delete("/:id", authorize({ platformOnly: true }), validate({ params: companyIdParams }), asyncHandler(c.remove));
