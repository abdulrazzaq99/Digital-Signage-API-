import argon2 from "argon2";
import { nanoid } from "nanoid";
import { env } from "../../config/env.js";
import type { AuthUser } from "../../core/auth/scope.js";
import { randomToken, sha256, signAccess, signRefresh, ttlToMs, verifyRefresh } from "../../core/auth/tokens.js";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../../core/errors/AppError.js";
import { logger } from "../../core/middleware/logger.js";
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

export function toDto(u: User) {
  return { id: u.id, email: u.email, name: u.name, platformRole: u.platformRole, companyRole: u.companyRole, companyId: u.companyId, title: u.title, phone: u.phone };
}

async function issueTokens(user: User, familyId: string, meta?: { userAgent?: string; ip?: string }): Promise<TokenPair> {
  const jti = nanoid(21);
  const refreshToken = signRefresh(user.id, jti, familyId);
  await repo.createRefreshToken({ userId: user.id, tokenHash: sha256(refreshToken), familyId, expiresAt: new Date(Date.now() + ttlToMs(env.JWT_REFRESH_TTL)), ...meta });
  return { accessToken: signAccess(toAuthUser(user)), refreshToken, expiresIn: Math.floor(ttlToMs(env.JWT_ACCESS_TTL) / 1000), user: toDto(user) };
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

  /** Rotates the refresh token. Reuse of an already-rotated token revokes the whole family. */
  async refresh(refreshToken: string, meta?: { userAgent?: string; ip?: string }): Promise<TokenPair> {
    const claims = verifyRefresh(refreshToken);
    const stored = await repo.findRefreshToken(sha256(refreshToken));
    if (!stored) throw new UnauthorizedError("Unknown refresh token", "INVALID_TOKEN");
    if (stored.revokedAt) {
      await repo.revokeFamily(stored.familyId);
      logger.warn({ userId: stored.userId, familyId: stored.familyId }, "Refresh token reuse detected; family revoked");
      throw new UnauthorizedError("Refresh token has been revoked", "TOKEN_REUSED");
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedError("Refresh token expired", "REFRESH_EXPIRED");
    const user = await repo.findUserById(claims.sub);
    if (!user || !user.isActive) throw new UnauthorizedError("Account unavailable", "ACCOUNT_DISABLED");
    const pair = await issueTokens(user, stored.familyId, meta);
    await repo.rotateRefreshToken(stored.id, sha256(pair.refreshToken));
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
    const token = randomToken(32);
    await repo.createPasswordReset({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    // Mail delivery is a provider concern; the token is logged in non-production for manual testing.
    if (env.NODE_ENV !== "production") logger.info({ email, token }, "Password reset token issued");
  },

  async resetPassword(token: string, password: string): Promise<void> {
    const reset = await repo.findPasswordReset(sha256(token));
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) throw new ValidationError("Reset link is invalid or has expired", undefined, "RESET_INVALID");
    await repo.updatePassword(reset.userId, await argon2.hash(password));
    await repo.usePasswordReset(reset.id);
    await repo.revokeAllForUser(reset.userId);
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await repo.findUserById(userId);
    if (!user) throw new UnauthorizedError();
    if (!(await argon2.verify(user.passwordHash, currentPassword))) throw new ValidationError("Current password is incorrect", undefined, "PASSWORD_MISMATCH");
    await repo.updatePassword(userId, await argon2.hash(newPassword));
    await repo.revokeAllForUser(userId);
  },
};

const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$VYq6fN5bR0dP3Xm7O2Jq9K2vX6r5h4d6xg2jlZcz0Fg";
