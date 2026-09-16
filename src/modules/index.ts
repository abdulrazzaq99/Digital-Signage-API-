import { Router } from "express";
import { authRouter } from "./auth/auth.routes.js";
import { companiesRouter } from "./companies/companies.routes.js";
import { companyLicenseRouter, licensesRouter } from "./licenses/licenses.routes.js";
import { usersRouter } from "./users/users.routes.js";
import { groupsRouter, screensRouter } from "./screens/screens.routes.js";
import { playerRouter } from "./player/player.routes.js";
import { mediaRouter } from "./media/media.routes.js";
import { playlistsRouter } from "./playlists/playlists.routes.js";
import { schedulesRouter } from "./schedules/schedules.routes.js";

/** Mounts every domain router under /api/v1. Modules are added here as they are built. */
export const apiRouter = Router();
apiRouter.use("/auth", authRouter);
apiRouter.use("/companies/:companyId/license", companyLicenseRouter);
apiRouter.use("/companies", companiesRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/licenses", licensesRouter);
apiRouter.use("/screens", screensRouter);
apiRouter.use("/screen-groups", groupsRouter);
apiRouter.use("/player", playerRouter);
apiRouter.use("/media", mediaRouter);
apiRouter.use("/playlists", playlistsRouter);
apiRouter.use("/schedules", schedulesRouter);
