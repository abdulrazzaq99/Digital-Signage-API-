import { Router } from "express";
import { asyncHandler } from "../../core/middleware/asyncHandler.js";
import { authenticateDevice } from "../../core/middleware/authenticate.js";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { playerController as c } from "./player.controller.js";
import { diagnosticsBody, heartbeatBody, pairingSessionBody, sessionParams, syncAckBody } from "./player.schemas.js";

export const playerRouter = Router();

playerRouter.post("/pairing-sessions", rateLimit({ name: "pairing-session", limit: 20, windowSec: 60 }), validate({ body: pairingSessionBody }), asyncHandler(c.createPairingSession));
playerRouter.get("/pairing-sessions/:sessionId", rateLimit({ name: "pairing-poll", limit: 120, windowSec: 60 }), validate({ params: sessionParams }), asyncHandler(c.pollPairingSession));

playerRouter.use(authenticateDevice());
playerRouter.get("/manifest", asyncHandler(c.manifest));
playerRouter.post("/heartbeat", validate({ body: heartbeatBody }), asyncHandler(c.heartbeat));
playerRouter.post("/sync-ack", validate({ body: syncAckBody }), asyncHandler(c.syncAck));
playerRouter.post("/diagnostics", validate({ body: diagnosticsBody }), asyncHandler(c.diagnostics));
