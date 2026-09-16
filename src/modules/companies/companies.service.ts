import type { AuthUser, TenantScope } from "../../core/auth/scope.js";
import { logActivity } from "../../core/audit/activity.js";
import { ForbiddenError, NotFoundError } from "../../core/errors/AppError.js";
import { paginate, pageMeta, type PaginationQuery } from "../../core/http/pagination.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { companiesRepository as repo } from "./companies.repository.js";
import type { z } from "zod";
import type { createCompanyBody, listCompaniesQuery, updateCompanyBody } from "./companies.schemas.js";

type CompanyRow = NonNullable<Awaited<ReturnType<typeof repo.findById>>>;

function toDto(c: CompanyRow, counts?: { screens: number; online: number; offline: number }) {
  return {
    id: c.id, code: c.code, name: c.name, status: c.status, website: c.website, industry: c.industry, phone: c.phone, timezone: c.timezone, plan: c.plan, overLimit: c.overLimit, createdAt: c.createdAt.toISOString(),
    license: c.license ? { screenLimit: c.license.screenLimit, state: c.license.state, overLimit: c.license.overLimit } : null,
    ...(counts ? { counts: { ...counts, available: Math.max(0, (c.license?.screenLimit ?? 0) - counts.screens) } } : {}),
  };
}

/** Customers may only read their own company; everything else is Super Admin only. */
function assertCanRead(scope: TenantScope, id: string) {
  if (scope.kind === "company" && scope.companyId !== id) throw new NotFoundError("Company");
}

export const companiesService = {
  async list(scope: TenantScope, q: z.infer<typeof listCompaniesQuery>) {
    if (scope.kind !== "platform") throw new ForbiddenError("Super Admin access required", "PLATFORM_ONLY");
    const where: Prisma.CompanyWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { code: { contains: q.search } }] } : {}),
    };
    const { skip, take } = paginate(q);
    const [rows, total] = await repo.list(where, skip, take);
    const withCounts = await Promise.all(rows.map(async (c) => toDto(c, await repo.screenCounts(c.id))));
    return { data: withCounts, meta: pageMeta(q as PaginationQuery, total) };
  },

  async get(scope: TenantScope, id: string) {
    assertCanRead(scope, id);
    const c = await repo.findById(id);
    if (!c) throw new NotFoundError("Company");
    return toDto(c, await repo.screenCounts(c.id));
  },

  async create(actor: AuthUser, body: z.infer<typeof createCompanyBody>) {
    const { screenLimit, licenseState, ...rest } = body;
    const c = await repo.create({ ...rest, code: await repo.nextCode(), license: { create: { screenLimit, state: licenseState } } });
    await logActivity({ companyId: c.id, actor, action: "company.created", resourceType: "company", resourceId: c.id, summary: `"${c.name}" onboarded with ${screenLimit} screen licenses` });
    return toDto(c, { screens: 0, online: 0, offline: 0 });
  },

  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateCompanyBody>) {
    assertCanRead(scope, id);
    if (scope.kind === "company" && body.status !== undefined) throw new ForbiddenError("Only the Super Admin can change company status", "PLATFORM_ONLY");
    const existing = await repo.findById(id);
    if (!existing) throw new NotFoundError("Company");
    const c = await repo.update(id, body);
    await logActivity({ companyId: id, actor, action: "company.updated", resourceType: "company", resourceId: id, summary: `${c.name} details updated`, meta: { fields: Object.keys(body) } });
    return toDto(c, await repo.screenCounts(id));
  },

  async remove(actor: AuthUser, id: string) {
    const existing = await repo.findById(id);
    if (!existing) throw new NotFoundError("Company");
    const counts = await repo.screenCounts(id);
    await repo.delete(id);
    await logActivity({ actor, action: "company.deleted", resourceType: "company", resourceId: id, summary: `"${existing.name}" deleted (${counts.screens} screens removed)` });
  },
};
