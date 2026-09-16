import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { campaignsController as c } from "./campaigns.controller.js";
import { addPrizeBody, createCampaignBody, idParams, listCampaignsQuery, listWinnersQuery, prizeParams, updateCampaignBody } from "./campaigns.schemas.js";

export const campaignsRouter = Router();
campaignsRouter.use(authenticate());
campaignsRouter.get("/", authorize(), validate({ query: listCampaignsQuery }), asyncHandler(c.list));
campaignsRouter.post("/", authorize({ platformOnly: true }), validate({ body: createCampaignBody }), asyncHandler(c.create));
campaignsRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.get));
campaignsRouter.patch("/:id", authorize({ platformOnly: true }), validate({ params: idParams, body: updateCampaignBody }), asyncHandler(c.update));
campaignsRouter.post("/:id/activate", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(c.activate));
campaignsRouter.post("/:id/deactivate", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(c.deactivate));
campaignsRouter.post("/:id/prizes", authorize({ platformOnly: true }), validate({ params: idParams, body: addPrizeBody }), asyncHandler(c.addPrize));
campaignsRouter.delete("/:id/prizes/:prizeId", authorize({ platformOnly: true }), validate({ params: prizeParams }), asyncHandler(c.removePrize));
campaignsRouter.get("/:id/eligibility", authorize(), validate({ params: idParams }), asyncHandler(c.eligibility));
campaignsRouter.post("/:id/attempts", authorize(), rateLimit({ name: "scratch", key: (req) => req.user?.id ?? req.ip ?? "anon", limit: 30, windowSec: 60 }), validate({ params: idParams }), asyncHandler(c.attempt));

export const winnersRouter = Router();
winnersRouter.use(authenticate());
winnersRouter.get("/", authorize({ platformOnly: true }), validate({ query: listWinnersQuery }), asyncHandler(c.listWinners));
winnersRouter.post("/:id/redeem", authorize({ platformOnly: true }), validate({ params: idParams }), asyncHandler(c.redeem));
