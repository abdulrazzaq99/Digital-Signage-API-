import { prisma } from "../../core/db/prisma.js";

export const authRepository = {
  findUserByEmail: (email: string) => prisma.user.findUnique({ where: { email: email.toLowerCase() } }),
  findUserById: (id: string) => prisma.user.findUnique({ where: { id } }),
  touchLogin: (id: string) => prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } }),
  updatePassword: (id: string, passwordHash: string) => prisma.user.update({ where: { id }, data: { passwordHash } }),

  createRefreshToken: (data: { userId: string; tokenHash: string; familyId: string; expiresAt: Date; userAgent?: string; ip?: string }) => prisma.refreshToken.create({ data }),
  findRefreshToken: (tokenHash: string) => prisma.refreshToken.findUnique({ where: { tokenHash } }),
  rotateRefreshToken: (id: string, replacedById: string) => prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date(), replacedById } }),
  revokeFamily: (familyId: string) => prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } }),
  revokeAllForUser: (userId: string) => prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),

  createPasswordReset: (data: { userId: string; tokenHash: string; expiresAt: Date }) => prisma.passwordReset.create({ data }),
  findPasswordReset: (tokenHash: string) => prisma.passwordReset.findUnique({ where: { tokenHash } }),
  usePasswordReset: (id: string) => prisma.passwordReset.update({ where: { id }, data: { usedAt: new Date() } }),
};
