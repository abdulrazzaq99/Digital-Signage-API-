import type { RequestHandler } from "express";
import { readOnlyReason, standingSelect, type ReadOnlyReason } from "../auth/account.js";
import { sha256, verifyAccess } from "../auth/tokens.js";
import type { AuthUser } from "../auth/scope.js";
import { prisma } from "../db/prisma.js";
import { UnauthorizedError } from "../errors/AppError.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    /** Loaded once per request by authenticate(): why the caller's company is read-only, if it is. */
    readOnlyReason?: ReadOnlyReason | null;
    screen?: { id: string; companyId: string };
  }
}

function bearer(header?: string): string {
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = header.slice(7).trim();
  if (!token) throw new UnauthorizedError();
  return token;
}

/**
 * User JWT authentication. Puts the user on `req.user`. One primary-key lookup per request checks
 * the account is still active (a deactivated user's access token stops working at once, not when it
 * expires) and takes the role and company from the database rather than the token, so a demotion
 * applies immediately. The company's standing is loaded in the same query for the read-only check.
 */
export function authenticate(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const claims = verifyAccess(bearer(req.header("authorization")));
      const user = await prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, email: true, name: true, platformRole: true, companyRole: true, companyId: true, isActive: true, company: { select: standingSelect } },
      });
      if (!user || !user.isActive) throw new UnauthorizedError("This account is disabled", "ACCOUNT_DISABLED");
      req.user = { id: user.id, email: user.email, name: user.name, platformRole: user.platformRole, companyRole: user.companyRole, companyId: user.companyId };
      req.readOnlyReason = user.platformRole === "SUPER_ADMIN" ? null : readOnlyReason(user.company);
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
