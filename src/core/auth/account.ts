import type { CompanyStatus, LicenseState } from "../../generated/prisma/enums.js";

/**
 * Why a company is read-only. Its users can still sign in and read, but every change is refused
 * until the Super Admin reactivates the company or renews the licence. Screens keep playing their
 * last content.
 */
export type ReadOnlyReason = "COMPANY_SUSPENDED" | "COMPANY_INACTIVE" | "LICENSE_EXPIRED" | "LICENSE_SUSPENDED" | "LICENSE_DISABLED";

export const READ_ONLY_MESSAGES: Record<ReadOnlyReason, string> = {
  COMPANY_SUSPENDED: "This account is suspended. Contact your administrator.",
  COMPANY_INACTIVE: "This account is inactive. Contact your administrator.",
  LICENSE_EXPIRED: "This account's licence has expired. Contact your administrator.",
  LICENSE_SUSPENDED: "This account's licence is suspended. Contact your administrator.",
  LICENSE_DISABLED: "This account's licence is disabled. Contact your administrator.",
};

export interface CompanyStanding {
  status: CompanyStatus;
  license: { state: LicenseState; expiresAt: Date | null } | null;
}

/** Prisma `select` that loads what {@link readOnlyReason} needs. */
export const standingSelect = { status: true, license: { select: { state: true, expiresAt: true } } } as const;

/**
 * The company's effective read-only reason, or null when it may make changes. A licence past its
 * `expiresAt` counts as expired even before the worker's sweep marks it EXPIRED. A company without a
 * licence row is not locked here; pairing and publishing refuse it on their own.
 */
export function readOnlyReason(company: CompanyStanding | null | undefined, now = new Date()): ReadOnlyReason | null {
  if (!company) return null;
  if (company.status === "SUSPENDED") return "COMPANY_SUSPENDED";
  if (company.status === "INACTIVE") return "COMPANY_INACTIVE";
  const l = company.license;
  if (!l) return null;
  if (l.state === "EXPIRED" || (l.expiresAt && l.expiresAt <= now)) return "LICENSE_EXPIRED";
  if (l.state === "SUSPENDED") return "LICENSE_SUSPENDED";
  if (l.state === "DISABLED") return "LICENSE_DISABLED";
  return null;
}
