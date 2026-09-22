import type { RequestHandler } from "express";
import { sha256, verifyAccess } from "../auth/tokens.js";
import type { AuthUser } from "../auth/scope.js";
import { prisma } from "../db/prisma.js";
import { UnauthorizedError } from "../errors/AppError.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    screen?: { id: string; companyId: string };
  }
}

function bearer(header?: string): string {
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = header.slice(7).trim();
  if (!token) throw new UnauthorizedError();
  return token;
}

/** User JWT authentication. Puts the decoded user on `req.user`. */
export function authenticate(): RequestHandler {
  return (req, _res, next) => {
    try {
      const claims = verifyAccess(bearer(req.header("authorization")));
      req.user = { id: claims.sub, email: claims.email, name: claims.name, platformRole: claims.platformRole, companyRole: claims.companyRole, companyId: claims.companyId };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Device credential authentication for the Android player. Puts the bound screen on `req.screen`. */
export function authenticateDevice(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const credential = bearer(req.header("authorization"));
      const screen = await prisma.screen.findUnique({ where: { deviceCredentialHash: sha256(credential) }, select: { id: true, companyId: true, pairingStatus: true, lastSeenAt: true } });
      if (!screen || screen.pairingStatus !== "PAIRED") throw new UnauthorizedError("Device is not paired", "DEVICE_UNAUTHORIZED");
      // First use of the credential closes the pairing session's re-claim window.
      if (!screen.lastSeenAt) await prisma.screen.update({ where: { id: screen.id }, data: { lastSeenAt: new Date() } });
      req.screen = { id: screen.id, companyId: screen.companyId };
      next();
    } catch (err) {
      next(err);
    }
  };
}
