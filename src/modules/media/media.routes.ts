import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { validate } from "../../core/middleware/validate.js";
import { mediaController as c } from "./media.controller.js";
import { deleteQuery, finalizeBody, idParams, listMediaQuery, updateMediaBody, uploadUrlBody } from "./media.schemas.js";

const editors = ["ADMIN", "EDITOR"] as const;

export const mediaRouter = Router();
mediaRouter.use(authenticate());
mediaRouter.get("/", authorize(), validate({ query: listMediaQuery }), asyncHandler(c.list));
mediaRouter.post("/upload-url", authorize({ roles: [...editors] }), validate({ body: uploadUrlBody }), asyncHandler(c.uploadUrl));
mediaRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.get));
mediaRouter.get("/:id/download-url", authorize(), validate({ params: idParams }), asyncHandler(c.downloadUrl));
mediaRouter.post("/:id/upload-url", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.reissueUploadUrl));
mediaRouter.post("/:id/finalize", authorize({ roles: [...editors] }), validate({ params: idParams, body: finalizeBody }), asyncHandler(c.finalize));
mediaRouter.post("/:id/retry", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.retry));
mediaRouter.patch("/:id", authorize({ roles: [...editors] }), validate({ params: idParams, body: updateMediaBody }), asyncHandler(c.update));
mediaRouter.delete("/:id", authorize({ roles: [...editors] }), validate({ params: idParams, query: deleteQuery }), asyncHandler(c.remove));
