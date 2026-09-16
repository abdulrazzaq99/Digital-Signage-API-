import { prisma } from "../../core/db/prisma.js";
import type { Tx } from "../../core/db/transaction.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const licensesRepository = {
  listAll: () => prisma.license.findMany({ include: { company: { select: { name: true, code: true } } }, orderBy: { company: { name: "asc" } } }),
  findByCompany: (companyId: string, tx?: Tx) => (tx ?? prisma).license.findUnique({ where: { companyId } }),
  /** Row-level lock used by pairing and limit changes. */
  lockByCompany: async (companyId: string, tx: Tx) => {
    const rows = await tx.$queryRaw<{ id: string; screenLimit: number; state: string }[]>`SELECT "id", "screenLimit", "state" FROM "License" WHERE "companyId" = ${companyId} FOR UPDATE`;
    return rows[0] ?? null;
  },
  pairedCount: (companyId: string, tx?: Tx) => (tx ?? prisma).screen.count({ where: { companyId, pairingStatus: "PAIRED" } }),
  update: (companyId: string, data: Prisma.LicenseUpdateInput, tx?: Tx) => (tx ?? prisma).license.update({ where: { companyId }, data }),
};
