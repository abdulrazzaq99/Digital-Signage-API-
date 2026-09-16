import type { CompanyRole, PlatformRole } from "../../generated/prisma/enums.js";
import { ForbiddenError } from "../errors/AppError.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  platformRole: PlatformRole;
  companyRole: CompanyRole | null;
  companyId: string | null;
}

/**
 * Every repository call is scoped. Platform scope belongs to the Super Admin and may
 * optionally target one company; company scope is pinned to the caller's own tenant.
 */
export type TenantScope = { kind: "platform"; companyId?: string } | { kind: "company"; companyId: string };

export function scopeFor(user: AuthUser, requestedCompanyId?: string): TenantScope {
  if (user.platformRole === "SUPER_ADMIN") return { kind: "platform", companyId: requestedCompanyId };
  if (!user.companyId) throw new ForbiddenError("User is not attached to a company", "NO_COMPANY");
  return { kind: "company", companyId: user.companyId };
}

/** Company ID a query must be filtered by, or undefined for platform-wide reads. */
export function scopedCompanyId(scope: TenantScope): string | undefined {
  return scope.companyId;
}

/** Company ID required for writes; platform callers must name the company explicitly. */
export function requireCompanyId(scope: TenantScope): string {
  if (!scope.companyId) throw new ForbiddenError("A company must be specified for this action", "COMPANY_REQUIRED");
  return scope.companyId;
}

export function isPlatform(scope: TenantScope): boolean {
  return scope.kind === "platform";
}

/** Prisma `where` fragment that pins a query to the scope's tenant. */
export function tenantWhere(scope: TenantScope): { companyId?: string } {
  return scope.companyId ? { companyId: scope.companyId } : {};
}
