import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticate } from "../../core/middleware/authenticate.js";
import { authorize } from "../../core/middleware/authorize.js";
import { idempotency } from "../../core/middleware/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import { playlistsController as c } from "./playlists.controller.js";
import { addItemBody, createPlaylistBody, idParams, itemParams, listPlaylistsQuery, publishBody, reorderBody, updateItemBody, updatePlaylistBody } from "./playlists.schemas.js";

const editors = ["ADMIN", "EDITOR"] as const;

export const playlistsRouter = Router();
playlistsRouter.use(authenticate());
playlistsRouter.get("/", authorize(), validate({ query: listPlaylistsQuery }), asyncHandler(c.list));
playlistsRouter.post("/", authorize({ roles: [...editors] }), validate({ body: createPlaylistBody }), asyncHandler(c.create));
playlistsRouter.get("/:id", authorize(), validate({ params: idParams }), asyncHandler(c.get));
playlistsRouter.patch("/:id", authorize({ roles: [...editors] }), validate({ params: idParams, body: updatePlaylistBody }), asyncHandler(c.update));
playlistsRouter.delete("/:id", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.remove));
playlistsRouter.post("/:id/duplicate", authorize({ roles: [...editors] }), validate({ params: idParams }), asyncHandler(c.duplicate));
playlistsRouter.post("/:id/items", authorize({ roles: [...editors] }), validate({ params: idParams, body: addItemBody }), asyncHandler(c.addItem));
playlistsRouter.patch("/:id/items/:itemId", authorize({ roles: [...editors] }), validate({ params: itemParams, body: updateItemBody }), asyncHandler(c.updateItem));
playlistsRouter.delete("/:id/items/:itemId", authorize({ roles: [...editors] }), validate({ params: itemParams }), asyncHandler(c.removeItem));
playlistsRouter.put("/:id/reorder", authorize({ roles: [...editors] }), validate({ params: idParams, body: reorderBody }), asyncHandler(c.reorder));
playlistsRouter.post("/:id/publish", authorize({ roles: [...editors] }), idempotency(), validate({ params: idParams, body: publishBody }), asyncHandler(c.publish));
