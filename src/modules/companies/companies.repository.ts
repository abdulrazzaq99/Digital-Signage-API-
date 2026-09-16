import { prisma } from "../../core/db/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";

const include = { license: { select: { screenLimit: true, state: true, overLimit: true } } } satisfies Prisma.CompanyInclude;

export const companiesRepository = {
  list: (where: Prisma.CompanyWhereInput, skip: number, take: number) =>
    Promise.all([prisma.company.findMany({ where, include, orderBy: { createdAt: "desc" }, skip, take }), prisma.company.count({ where })]),
  findById: (id: string) => prisma.company.findUnique({ where: { id }, include }),
  nextCode: async () => {
    const last = await prisma.company.findFirst({ orderBy: { code: "desc" }, select: { code: true } });
    const n = last ? parseInt(last.code, 10) + 1 : 1;
    return String(Number.isFinite(n) ? n : 1).padStart(5, "0");
  },
  create: (data: Prisma.CompanyCreateInput) => prisma.company.create({ data, include }),
  update: (id: string, data: Prisma.CompanyUpdateInput) => prisma.company.update({ where: { id }, data, include }),
  delete: (id: string) => prisma.company.delete({ where: { id } }),
  screenCounts: async (companyId: string) => {
    const [screens, online] = await Promise.all([prisma.screen.count({ where: { companyId, pairingStatus: "PAIRED" } }), prisma.screen.count({ where: { companyId, pairingStatus: "PAIRED", status: "ONLINE" } })]);
    return { screens, online, offline: screens - online };
  },
};
