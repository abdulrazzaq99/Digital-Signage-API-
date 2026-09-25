import argon2 from "argon2";
import { signAccess } from "../core/auth/tokens.js";
import { prisma } from "../core/db/prisma.js";
import type { CompanyRole, LicenseState } from "../generated/prisma/enums.js";
import { api } from "./helpers.js";

let counter = 0;
const next = () => ++counter;

export async function createCompany(overrides: { name?: string; screenLimit?: number; licenseState?: LicenseState } = {}) {
  const n = next();
  const company = await prisma.company.create({ data: { code: `T${String(n).padStart(5, "0")}`, name: overrides.name ?? `Company ${n}` } });
  await prisma.license.create({ data: { companyId: company.id, screenLimit: overrides.screenLimit ?? 5, state: overrides.licenseState ?? "ACTIVE" } });
  return company;
}

export async function createUser(overrides: { email?: string; password?: string; companyId?: string | null; companyRole?: CompanyRole; superAdmin?: boolean; isActive?: boolean } = {}) {
  const n = next();
  const password = overrides.password ?? "Passw0rd!";
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? `user${n}@test.local`,
      name: `User ${n}`,
      passwordHash: await argon2.hash(password),
      platformRole: overrides.superAdmin ? "SUPER_ADMIN" : "CUSTOMER",
      companyRole: overrides.superAdmin ? null : (overrides.companyRole ?? "ADMIN"),
      companyId: overrides.superAdmin ? null : (overrides.companyId ?? null),
      isActive: overrides.isActive ?? true,
    },
  });
  return { ...user, password };
}

export async function login(email: string, password: string) {
  const res = await api().post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { accessToken: string; refreshToken: string };
}

/** Signs an access token directly, bypassing the login rate limiter for bulk test users. */
export function tokenFor(user: { id: string; email: string; name: string; platformRole: "SUPER_ADMIN" | "CUSTOMER"; companyRole: CompanyRole | null; companyId: string | null }): string {
  return signAccess({ id: user.id, email: user.email, name: user.name, platformRole: user.platformRole, companyRole: user.companyRole, companyId: user.companyId });
}

/** Creates a company with an Admin user and returns a ready-to-use bearer header. */
export async function customerContext(overrides: { screenLimit?: number; licenseState?: LicenseState; companyRole?: CompanyRole } = {}) {
  const company = await createCompany(overrides);
  const user = await createUser({ companyId: company.id, companyRole: overrides.companyRole ?? "ADMIN" });
  const tokens = await login(user.email, user.password);
  return { company, user, tokens, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
}

export async function superAdminContext() {
  const user = await createUser({ superAdmin: true });
  const tokens = await login(user.email, user.password);
  return { user, tokens, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
}

/** Well-formed ids that match no row: they pass request validation, so tests reach the business rule. */
export const MISSING_ID = "cmissing0000000000000000a";
export const OTHER_MISSING_ID = "cmissing0000000000000000b";
