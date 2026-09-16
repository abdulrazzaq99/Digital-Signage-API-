import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { UnauthorizedError } from "../errors/AppError.js";
import type { AuthUser } from "./scope.js";

export interface AccessClaims {
  sub: string;
  email: string;
  name: string;
  platformRole: AuthUser["platformRole"];
  companyRole: AuthUser["companyRole"];
  companyId: string | null;
  type: "access";
}

export interface RefreshClaims {
  sub: string;
  jti: string;
  family: string;
  type: "refresh";
}

export function signAccess(user: AuthUser): string {
  const claims: AccessClaims = { sub: user.id, email: user.email, name: user.name, platformRole: user.platformRole, companyRole: user.companyRole, companyId: user.companyId, type: "access" };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"] });
}

export function signRefresh(userId: string, jti: string, family: string): string {
  const claims: RefreshClaims = { sub: userId, jti, family, type: "refresh" };
  return jwt.sign(claims, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions["expiresIn"] });
}

export function verifyAccess(token: string): AccessClaims {
  try {
    const claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims;
    if (claims.type !== "access") throw new UnauthorizedError("Invalid token type", "INVALID_TOKEN");
    return claims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new UnauthorizedError("Access token expired", "TOKEN_EXPIRED");
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Invalid access token", "INVALID_TOKEN");
  }
}

export function verifyRefresh(token: string): RefreshClaims {
  try {
    const claims = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshClaims;
    if (claims.type !== "refresh") throw new UnauthorizedError("Invalid token type", "INVALID_TOKEN");
    return claims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new UnauthorizedError("Refresh token expired", "REFRESH_EXPIRED");
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Invalid refresh token", "INVALID_TOKEN");
  }
}

export function ttlToMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 15 * 60 * 1000;
  const n = Number(m[1]);
  return n * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"] ?? 60_000);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}
