import type { RequestHandler } from "express";
import { COMPANY_HEADER } from "../../config/constants.js";
import { scopeFor, type TenantScope } from "../auth/scope.js";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../errors/AppError.js";
import { id } from "../validation/fields.js";
import type { CompanyRole } from "../../generated/prisma/enums.js";

declare module "express-serve-static-core" {
  interface Request {
    scope: TenantScope;
  }
}

interface AuthorizeOptions {
  /** Company roles allowed for customer users. Super Admin always passes. */
  roles?: CompanyRole[];
  /** Only the Super Admin may call. */
  platformOnly?: boolean;
}

const companyIdSchema = id();

/**
 * Resolves the tenant scope for the request and enforces role rules.
 * Super Admin may target a company via the X-Company-Id header or `companyId` query.
 */
export function authorize(opts: AuthorizeOptions = {}): RequestHandler {
  return (req, _res, next) => {
    try {
      if (!req.user) throw new UnauthorizedError();
      const isSuper = req.user.platformRole === "SUPER_ADMIN";
      if (opts.platformOnly && !isSuper) throw new ForbiddenError("Super Admin access required", "PLATFORM_ONLY");
      if (!isSuper && opts.roles && (!req.user.companyRole || !opts.roles.includes(req.user.companyRole))) {
        throw new ForbiddenError(`Requires role: ${opts.roles.join(" or ")}`, "INSUFFICIENT_ROLE");
      }
      const header = req.header(COMPANY_HEADER);
      const requested = header ?? (typeof req.query.companyId === "string" ? req.query.companyId : undefined);
      // Only the Super Admin's choice is used, so only theirs is checked; customers stay pinned to their own company.
      if (isSuper && requested && !companyIdSchema.safeParse(requested).success) {
        throw new ValidationError("Validation failed", [{ path: header !== undefined ? `headers.${COMPANY_HEADER}` : "query.companyId", message: "Invalid id" }]);
      }
      req.scope = scopeFor(req.user, requested);
      next();
    } catch (err) {
      next(err);
    }
  };
}
