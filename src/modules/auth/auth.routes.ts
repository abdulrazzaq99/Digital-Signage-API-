import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { authController as c } from "./auth.controller.js";
import { changePasswordBody, forgotBody, loginBody, refreshBody, resetBody } from "./auth.schemas.js";

export const authRouter = Router();

const loginLimiter = rateLimit({ name: "login", limit: 10, windowSec: 60 });
const resetLimiter = rateLimit({ name: "reset", limit: 5, windowSec: 60 });

authRouter.post("/login", loginLimiter, validate({ body: loginBody }), asyncHandler(c.login));
authRouter.post("/refresh", validate({ body: refreshBody }), asyncHandler(c.refresh));
authRouter.post("/logout", validate({ body: refreshBody }), asyncHandler(c.logout));
authRouter.post("/forgot-password", resetLimiter, validate({ body: forgotBody }), asyncHandler(c.forgotPassword));
authRouter.post("/reset-password", resetLimiter, validate({ body: resetBody }), asyncHandler(c.resetPassword));
authRouter.get("/me", authenticate(), asyncHandler(c.me));
authRouter.post("/change-password", authenticate(), validate({ body: changePasswordBody }), asyncHandler(c.changePassword));
