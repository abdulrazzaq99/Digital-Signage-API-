import type { Request, Response } from "express";
import type { z } from "zod";
import { created, noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import { screensService } from "../screens/screens.service.js";
import type { diagnosticsBody, heartbeatBody, pairingSessionBody, syncAckBody } from "./player.schemas.js";
import { playerService as service } from "./player.service.js";

export const playerController = {
  async createPairingSession(req: Request, res: Response) {
    const { body } = input<z.infer<typeof pairingSessionBody>>(req);
    created(res, await screensService.createPairingSession(body));
  },
  async pollPairingSession(req: Request, res: Response) {
    const { params } = input<unknown, unknown, { sessionId: string }>(req);
    ok(res, await screensService.pollPairingSession(params.sessionId));
  },
  async manifest(req: Request, res: Response) {
    ok(res, await service.manifest(req.screen!.id));
  },
  async heartbeat(req: Request, res: Response) {
    const { body } = input<z.infer<typeof heartbeatBody>>(req);
    ok(res, await service.heartbeat(req.screen!.id, req.screen!.companyId, body));
  },
  async syncAck(req: Request, res: Response) {
    const { body } = input<z.infer<typeof syncAckBody>>(req);
    await service.syncAck(req.screen!.id, req.screen!.companyId, body);
    noContent(res);
  },
  async diagnostics(req: Request, res: Response) {
    const { body } = input<z.infer<typeof diagnosticsBody>>(req);
    await service.diagnostics(req.screen!.id, body);
    res.status(202).end();
  },
};
