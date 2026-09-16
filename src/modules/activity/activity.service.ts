import type { z } from "zod";
import { tenantWhere, type TenantScope } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { listActivityQuery } from "./activity.schemas.js";

export const activityService = {
  async list(scope: TenantScope, q: z.infer<typeof listActivityQuery>) {
    const where: Prisma.ActivityLogWhereInput = {
      ...tenantWhere(scope),
      ...(scope.kind === "platform" && q.companyId ? { companyId: q.companyId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.resourceType ? { resourceType: q.resourceType } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      ...(q.search ? { summary: { contains: q.search, mode: "insensitive" } } : {}),
    };
    const { skip, take } = paginate(q);
    const [rows, total] = await Promise.all([prisma.activityLog.findMany({ where, include: { company: { select: { id: true, name: true } }, actor: { select: { id: true, name: true, platformRole: true, companyRole: true } } }, orderBy: { createdAt: "desc" }, skip, take }), prisma.activityLog.count({ where })]);
    return {
      data: rows.map((r) => ({ id: r.id, action: r.action, resourceType: r.resourceType, resourceId: r.resourceId, status: r.status, summary: r.summary, meta: r.meta, company: r.company, actor: r.actor ? { id: r.actor.id, name: r.actor.name, role: r.actor.platformRole === "SUPER_ADMIN" ? "Super Admin" : (r.actor.companyRole ?? "User") } : null, createdAt: r.createdAt.toISOString() })),
      meta: pageMeta(q, total),
    };
  },
};
