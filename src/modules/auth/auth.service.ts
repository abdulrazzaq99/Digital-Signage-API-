import argon2 from "argon2";
import { nanoid } from "nanoid";
import { PASSWORD_RESET_TTL_SEC, REFRESH_REUSE_GRACE_SEC } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { readOnlyReason, type CompanyStanding } from "../../core/auth/account.js";
import type { AuthUser } from "../../core/auth/scope.js";
import { seal, unseal } from "../../core/auth/seal.js";
import { randomToken, sha256, signAccess, signRefresh, ttlToMs, verifyRefresh } from "../../core/auth/tokens.js";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../../core/errors/AppError.js";
import { queueMail } from "../../core/mail/index.js";
import { passwordResetEmail } from "../../core/mail/templates.js";
import { logger } from "../../core/middleware/logger.js";
import { passwordUsesEmail } from "../../core/validation/fields.js";
import { redis } from "../../core/redis/client.js";
import type { User } from "../../generated/prisma/client.js";
import { authRepository as repo } from "./auth.repository.js";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: ReturnType<typeof toDto>;
}

export function toAuthUser(u: User): AuthUser {
  return { id: u.id, email: u.email, name: u.name, platformRole: u.platformRole, companyRole: u.companyRole, companyId: u.companyId };
}

type UserWithStanding = User & { company: CompanyStanding | null };

export function toDto(u: UserWithStanding) {
  return { id: u.id, email: u.email, name: u.name, platformRole: u.platformRole, companyRole: u.companyRole, companyId: u.companyId, title: u.title, phone: u.phone, readOnlyReason: u.platformRole === "SUPER_ADMIN" ? null : readOnlyReason(u.company) };
}

async function issueTokens(user: UserWithStanding, familyId: string, meta?: { userAgent?: string; ip?: string }): Promise<TokenPair> {
  const jti = nanoid(21);
  const refreshToken = signRefresh(user.id, jti, familyId);
  await repo.createRefreshToken({ userId: user.id, tokenHash: sha256(refreshToken), familyId, expiresAt: new Date(Date.now() + ttlToMs(env.JWT_REFRESH_TTL)), ...meta });
  return { accessToken: signAccess(toAuthUser(user)), refreshToken, expiresIn: Math.floor(ttlToMs(env.JWT_ACCESS_TTL) / 1000), user: toDto(user) };
}

/** A single-use token for the reset-password page: forgot-password (1 hour) and invites (7 days). */
export async function issuePasswordToken(userId: string, ttlSec: number): Promise<string> {
  const token = randomToken(32);
  await repo.createPasswordReset({ userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlSec * 1000) });
  return token;
}

/** Rejects a new password built from the account's email name (the schema has already checked strength). */
export function assertPasswordAllowed(pw: string, userEmail: string, field: "password" | "newPassword"): void {
  if (passwordUsesEmail(pw, userEmail)) throw new ValidationError("Validation failed", [{ path: `body.${field}`, message: "Don't use your email name in your password" }]);
}

export const refreshGraceKey = (tokenHash: string) => `refresh:grace:${tokenHash}`;

/**
 * A rotated token was presented again. Within the grace window (and while the session is still
 * alive) answer with the pair issued at rotation; the winner of a simultaneous race may still be
 * writing it, so wait briefly for a rotation that happened a moment ago. Otherwise it is a replay.
 */
async function reuseOrGrace(tokenHash: string, familyId: string, userId: string, rotatedAt: Date): Promise<TokenPair> {
  const recent = Date.now() - rotatedAt.getTime() < 3000;
  for (let i = 0; i < (recent ? 20 : 1); i++) {
    const stored = await redis.get(refreshGraceKey(tokenHash));
    const cached = stored ? unseal(stored, tokenHash) : null;
    if (cached) {
      if (await repo.familyIsActive(familyId)) return JSON.parse(cached) as TokenPair;
      break;
    }
    if (recent) await new Promise((r) => setTimeout(r, 100));
  }
  await repo.revokeFamily(familyId);
  logger.warn({ userId, familyId }, "Refresh token reuse detected; family revoked");
  throw new UnauthorizedError("Refresh token has been revoked", "TOKEN_REUSED");
}

export const authService = {
  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }): Promise<TokenPair> {
    const user = await repo.findUserByEmail(email);
    // Verify against a dummy hash when the user is missing so timing does not reveal existence.
    const valid = user ? await argon2.verify(user.passwordHash, password) : (await argon2.verify(DUMMY_HASH, password), false);
    if (!user || !valid) throw new UnauthorizedError("Invalid email or password", "INVALID_CREDENTIALS");
    if (!user.isActive) throw new ForbiddenError("This account is disabled", "ACCOUNT_DISABLED");
    await repo.touchLogin(user.id);
    return issueTokens(user, nanoid(21), meta);
  },

  /**
   * Rotates the refresh token. A token rotated within the last REFRESH_REUSE_GRACE_SEC returns the
   * same new pair (parallel 401s, two tabs, a retried request); reuse after that revokes the family.
   */
  async refresh(refreshToken: string, meta?: { userAgent?: string; ip?: string }): Promise<TokenPair> {
    const claims = verifyRefresh(refreshToken);
    const hash = sha256(refreshToken);
    const stored = await repo.findRefreshToken(hash);
    if (!stored) throw new UnauthorizedError("Unknown refresh token", "INVALID_TOKEN");
    if (stored.expiresAt < new Date()) throw new UnauthorizedError("Refresh token expired", "REFRESH_EXPIRED");
    if (stored.revokedAt || !(await repo.claimRefreshToken(stored.id))) return reuseOrGrace(hash, stored.familyId, stored.userId, stored.revokedAt ?? new Date());
    const user = await repo.findUserById(claims.sub);
    if (!user || !user.isActive) throw new UnauthorizedError("Account unavailable", "ACCOUNT_DISABLED");
    const pair = await issueTokens(user, stored.familyId, meta);
    await repo.setReplacedBy(stored.id, sha256(pair.refreshToken));
    // The pair includes a live refresh token, so it is stored encrypted and bound to the old token's hash.
    await redis.set(refreshGraceKey(hash), seal(JSON.stringify(pair), hash), "EX", REFRESH_REUSE_GRACE_SEC);
    return pair;
  },

  async logout(refreshToken: string): Promise<void> {
    const stored = await repo.findRefreshToken(sha256(refreshToken)).catch(() => null);
    if (stored) await repo.revokeFamily(stored.familyId);
  },

  async me(userId: string) {
    const user = await repo.findUserById(userId);
    if (!user) throw new UnauthorizedError();
    return toDto(user);
  },

  async forgotPassword(email: string): Promise<void> {
    const user = await repo.findUserByEmail(email);
    if (!user) return; // do not reveal whether the email exists
    const token = await issuePasswordToken(user.id, PASSWORD_RESET_TTL_SEC);
    await queueMail(passwordResetEmail(user, token));
  },

  async resetPassword(token: string, password: string): Promise<void> {
    const reset = await repo.findPasswordReset(sha256(token));
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) throw new ValidationError("Reset link is invalid or has expired", undefined, "RESET_INVALID");
    const user = await repo.findUserById(reset.userId);
    if (!user) throw new ValidationError("Reset link is invalid or has expired", undefined, "RESET_INVALID");
    assertPasswordAllowed(password, user.email, "password");
    await repo.updatePassword(reset.userId, await argon2.hash(password));
    await repo.usePasswordReset(reset.id);
    await repo.revokeAllForUser(reset.userId);
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await repo.findUserById(userId);
    if (!user) throw new UnauthorizedError();
    if (newPassword === currentPassword) throw new ValidationError("Validation failed", [{ path: "body.newPassword", message: "Choose a different password" }]);
    assertPasswordAllowed(newPassword, user.email, "newPassword");
    if (!(await argon2.verify(user.passwordHash, currentPassword))) throw new ValidationError("Current password is incorrect", undefined, "PASSWORD_MISMATCH");
    await repo.updatePassword(userId, await argon2.hash(newPassword));
    await repo.revokeAllForUser(userId);
  },
};

const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$VYq6fN5bR0dP3Xm7O2Jq9K2vX6r5h4d6xg2jlZcz0Fg";
