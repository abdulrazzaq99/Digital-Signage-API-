import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { validate } from "../../core/middleware/validate.js";
import { notificationsController as c } from "./notifications.controller.js";
import { createNotificationBody, idParams, listNotificationsQuery, subscribeBody } from "./notifications.schemas.js";

export const notificationsRouter = Router();
notificationsRouter.use(authenticate());
notificationsRouter.get("/", authorize({ platformOnly: true }), validate({ query: listNotificationsQuery }), asyncHandler(c.list));
notificationsRouter.post("/", authorize({ platformOnly: true }), validate({ body: createNotificationBody }), asyncHandler(c.create));
notificationsRouter.post("/subscriptions", validate({ body: subscribeBody }), asyncHandler(c.subscribe));
notificationsRouter.delete("/subscriptions/:id", validate({ params: idParams }), asyncHandler(c.unsubscribe));
