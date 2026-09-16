import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { validate } from "../../core/middleware/validate.js";
import { usersController as c } from "./users.controller.js";
import { createUserBody, listUsersQuery, updateProfileBody, updateUserBody, userIdParams } from "./users.schemas.js";

export const usersRouter = Router();
usersRouter.use(authenticate());

usersRouter.patch("/me", validate({ body: updateProfileBody }), asyncHandler(c.updateProfile));
usersRouter.get("/", authorize(), validate({ query: listUsersQuery }), asyncHandler(c.list));
usersRouter.post("/", authorize({ roles: ["ADMIN"] }), validate({ body: createUserBody }), asyncHandler(c.create));
usersRouter.patch("/:id", authorize({ roles: ["ADMIN"] }), validate({ params: userIdParams, body: updateUserBody }), asyncHandler(c.update));
usersRouter.delete("/:id", authorize({ roles: ["ADMIN"] }), validate({ params: userIdParams }), asyncHandler(c.remove));
