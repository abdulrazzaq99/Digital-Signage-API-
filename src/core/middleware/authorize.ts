import type { Request, RequestHandler } from "express";
import { COMPANY_HEADER } from "../../config/constants.js";
import { READ_ONLY_MESSAGES } from "../auth/account.js";
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
  /** A POST that changes nothing the company owns (a conflict check, an offer view); allowed while read-only. */
  allowReadOnly?: boolean;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Refuses changes from a company that is suspended, inactive or whose licence has lapsed: its users
 * can read but not write (403 COMPANY_READ_ONLY). The Super Admin is never blocked, since they are
 * the one who manages the company. The reason was loaded once by authenticate().
 */
export function assertWritable(req: Request): void {
  if (!MUTATING.has(req.method) || req.user?.platformRole === "SUPER_ADMIN") return;
  const reason = req.readOnlyReason;
  if (reason) throw new ForbiddenError(READ_ONLY_MESSAGES[reason], "COMPANY_READ_ONLY");
}

/** The read-only check as a standalone middleware, for routes that don't use authorize(). */
export function requireWritableCompany(): RequestHandler {
  return (req, _res, next) => {
    try {
      assertWritable(req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

const companyIdSchema = id();

/**
 * Resolves the tenant scope for the request and enforces role rules and read-only mode.
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
      if (!opts.allowReadOnly) assertWritable(req);
      next();
    } catch (err) {
      next(err);
    }
  };
}
