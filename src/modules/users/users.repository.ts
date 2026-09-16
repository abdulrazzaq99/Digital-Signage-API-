import { prisma } from "../../core/db/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const usersRepository = {
  list: (where: Prisma.UserWhereInput, skip: number, take: number) => Promise.all([prisma.user.findMany({ where, orderBy: { createdAt: "asc" }, skip, take }), prisma.user.count({ where })]),
  findInCompany: (companyId: string, id: string) => prisma.user.findFirst({ where: { id, companyId } }),
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),
  countAdmins: (companyId: string) => prisma.user.count({ where: { companyId, companyRole: "ADMIN", isActive: true } }),
  create: (data: Prisma.UserUncheckedCreateInput) => prisma.user.create({ data }),
  update: (id: string, data: Prisma.UserUncheckedUpdateInput) => prisma.user.update({ where: { id }, data }),
  delete: (id: string) => prisma.user.delete({ where: { id } }),
};
