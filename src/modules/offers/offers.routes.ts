import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { validate } from "../../core/middleware/validate.js";
import { offersController as c } from "./offers.controller.js";
import { createOfferBody, idParams, listOffersQuery, updateOfferBody } from "./offers.schemas.js";

export const offersRouter = Router();
offersRouter.use(authenticate());
offersRouter.get("/", authorize(), validate({ query: listOffersQuery }), asyncHandler(c.list));
offersRouter.post("/", authorize({ platformOnly: true }), validate({ body: createOfferBody }), asyncHandler(c.create));
offersRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.get));
offersRouter.patch("/:id", authorize({ platformOnly: true }), validate({ params: idParams, body: updateOfferBody }), asyncHandler(c.update));
offersRouter.post("/:id/publish", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(c.publish));
offersRouter.post("/:id/unpublish", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(c.unpublish));
offersRouter.post("/:id/view", authorize(), validate({ params: idParams }), asyncHandler(c.view));
offersRouter.get("/:id/stats", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(c.stats));
offersRouter.delete("/:id", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(c.remove));
