import argon2 from "argon2";
import type { z } from "zod";
import { INVITE_TTL_SEC } from "../../config/constants.js";
import { logActivity } from "../../core/audit/activity.js";
import { randomToken } from "../../core/auth/tokens.js";
import { requireCompanyId, type AuthUser, type TenantScope } from "../../core/auth/scope.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { queueMail } from "../../core/mail/index.js";
import { inviteEmail } from "../../core/mail/templates.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import type { User } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { issuePasswordToken } from "../auth/auth.service.js";
import { usersRepository as repo } from "./users.repository.js";
import type { createUserBody, listUsersQuery, updateProfileBody, updateUserBody } from "./users.schemas.js";

export function toUserDto(u: User) {
  const status = !u.isActive ? "SUSPENDED" : u.invitedAt && !u.lastLoginAt ? "INVITED" : "ACTIVE";
  return { id: u.id, email: u.email, name: u.name, role: u.companyRole, title: u.title, phone: u.phone, status, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() };
}

export const usersService = {
  async list(scope: TenantScope, q: z.infer<typeof listUsersQuery>) {
    const companyId = requireCompanyId(scope);
    const where: Prisma.UserWhereInput = { companyId, ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { email: { contains: q.search, mode: "insensitive" } }] } : {}) };
    const { skip, take } = paginate(q);
    const [rows, total] = await repo.list(where, skip, take);
    return { data: rows.map(toUserDto), meta: pageMeta(q, total) };
  },

  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createUserBody>) {
    const companyId = requireCompanyId(scope);
    if (await repo.findByEmail(body.email.toLowerCase())) throw new ConflictError("A user with this email already exists", "EMAIL_TAKEN");
    const invited = !body.password;
    // An invitee's initial password is random and never shown; they choose their own through the emailed link.
    const password = body.password ?? randomToken(32);
    const user = await repo.create({ email: body.email.toLowerCase(), name: body.name, passwordHash: await argon2.hash(password), platformRole: "CUSTOMER", companyRole: body.role, companyId, title: body.title, phone: body.phone, invitedAt: invited ? new Date() : null });
    if (invited) {
      const company = await repo.findCompany(companyId);
      await queueMail(inviteEmail(user, company?.name ?? "your team", actor.name, await issuePasswordToken(user.id, INVITE_TTL_SEC)));
    }
    await logActivity({ companyId, actor, action: "user.created", resourceType: "user", resourceId: user.id, summary: `${user.name} added as ${body.role}` });
    return toUserDto(user);
  },

  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateUserBody>) {
    const companyId = requireCompanyId(scope);
    const existing = await repo.findInCompany(companyId, id);
    if (!existing) throw new NotFoundError("User");
    const demotingOrDisablingAdmin = existing.companyRole === "ADMIN" && ((body.role && body.role !== "ADMIN") || body.isActive === false);
    if (demotingOrDisablingAdmin && (await repo.countAdmins(companyId)) <= 1) throw new ValidationError("A company must keep at least one active Admin", undefined, "LAST_ADMIN");
    // Locking yourself out is never what an Admin meant; another Admin has to do it.
    if (existing.id === actor.id && (body.isActive === false || (body.role !== undefined && body.role !== existing.companyRole))) {
      throw new ConflictError("You cannot deactivate your own account or change your own role", "SELF_CHANGE");
    }
    const user = await repo.update(id, { name: body.name, companyRole: body.role, title: body.title, phone: body.phone, isActive: body.isActive });
    // Access tokens stop working at once (authenticate() checks isActive); sessions must not refresh either.
    if (body.isActive === false && existing.isActive) await repo.revokeSessions(id);
    await logActivity({ companyId, actor, action: "user.updated", resourceType: "user", resourceId: id, summary: `${user.name} updated`, meta: { fields: Object.keys(body) } });
    return toUserDto(user);
  },

  async remove(actor: AuthUser, scope: TenantScope, id: string) {
    const companyId = requireCompanyId(scope);
    const existing = await repo.findInCompany(companyId, id);
    if (!existing) throw new NotFoundError("User");
    if (existing.id === actor.id) throw new ValidationError("You cannot remove your own account", undefined, "SELF_REMOVAL");
    if (existing.companyRole === "ADMIN" && (await repo.countAdmins(companyId)) <= 1) throw new ValidationError("A company must keep at least one active Admin", undefined, "LAST_ADMIN");
    await repo.delete(id);
    await logActivity({ companyId, actor, action: "user.removed", resourceType: "user", resourceId: id, summary: `${existing.name} removed from the account` });
  },

  async updateProfile(actor: AuthUser, body: z.infer<typeof updateProfileBody>) {
    const user = await repo.update(actor.id, { name: body.name, title: body.title, phone: body.phone });
    return toUserDto(user);
  },
};
