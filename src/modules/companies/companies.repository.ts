import { prisma } from "../../core/db/prisma.js";
import type { Tx } from "../../core/db/transaction.js";
import type { Prisma } from "../../generated/prisma/client.js";

const include = { license: { select: { screenLimit: true, state: true, overLimit: true } } } satisfies Prisma.CompanyInclude;

/** Arbitrary constant for pg_advisory_xact_lock: serialises company-code allocation. */
const COMPANY_CODE_LOCK = 0x636f6465;

export const companiesRepository = {
  list: (where: Prisma.CompanyWhereInput, skip: number, take: number) =>
    Promise.all([prisma.company.findMany({ where, include, orderBy: { createdAt: "desc" }, skip, take }), prisma.company.count({ where })]),
  findById: (id: string) => prisma.company.findUnique({ where: { id }, include }),
  /**
   * Takes a transaction-scoped advisory lock, so two onboardings at once can't both read the same
   * highest code; the lock is released when the caller's transaction ends. Only numeric codes count
   * (compared by length first, so "10000" beats "9999").
   */
  nextCode: async (tx: Tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${COMPANY_CODE_LOCK})`;
    const [last] = await tx.$queryRaw<{ code: string }[]>`SELECT "code" FROM "Company" WHERE "code" ~ '^[0-9]+$' ORDER BY length("code") DESC, "code" DESC LIMIT 1`;
    const n = last ? parseInt(last.code, 10) + 1 : 1;
    return String(Number.isFinite(n) ? n : 1).padStart(5, "0");
  },
  create: (data: Prisma.CompanyCreateInput, tx?: Tx) => (tx ?? prisma).company.create({ data, include }),
  update: (id: string, data: Prisma.CompanyUpdateInput) => prisma.company.update({ where: { id }, data, include }),
  delete: (id: string) => prisma.company.delete({ where: { id } }),
  screenCounts: async (companyId: string) => {
    const [screens, online] = await Promise.all([prisma.screen.count({ where: { companyId, pairingStatus: "PAIRED" } }), prisma.screen.count({ where: { companyId, pairingStatus: "PAIRED", status: "ONLINE" } })]);
    return { screens, online, offline: screens - online };
  },
};
