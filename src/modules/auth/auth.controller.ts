import type { Request, Response } from "express";
import { noContent, ok } from "../../core/http/envelope.js";
import { input } from "../../core/middleware/validate.js";
import { authService } from "./auth.service.js";

const meta = (req: Request) => ({ userAgent: req.header("user-agent") ?? undefined, ip: req.ip });

export const authController = {
  async login(req: Request, res: Response) {
    const { body } = input<{ email: string; password: string }>(req);
    ok(res, await authService.login(body.email, body.password, meta(req)));
  },
  async refresh(req: Request, res: Response) {
    const { body } = input<{ refreshToken: string }>(req);
    ok(res, await authService.refresh(body.refreshToken, meta(req)));
  },
  async logout(req: Request, res: Response) {
    const { body } = input<{ refreshToken: string }>(req);
    await authService.logout(body.refreshToken);
    noContent(res);
  },
  async me(req: Request, res: Response) {
    ok(res, await authService.me(req.user!.id));
  },
  async forgotPassword(req: Request, res: Response) {
    const { body } = input<{ email: string }>(req);
    await authService.forgotPassword(body.email);
    res.status(202).json({ data: { message: "If the email exists, a reset link has been sent." } });
  },
  async resetPassword(req: Request, res: Response) {
    const { body } = input<{ token: string; password: string }>(req);
    await authService.resetPassword(body.token, body.password);
    noContent(res);
  },
  async changePassword(req: Request, res: Response) {
    const { body } = input<{ currentPassword: string; newPassword: string }>(req);
    await authService.changePassword(req.user!.id, body.currentPassword, body.newPassword);
    noContent(res);
  },
};
