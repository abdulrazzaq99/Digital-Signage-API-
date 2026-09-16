import { prisma } from "../../core/db/prisma.js";
import type { Tx } from "../../core/db/transaction.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const screenInclude = {
  device: true,
  assignment: true,
  groups: { include: { group: { select: { id: true, name: true } } } },
} satisfies Prisma.ScreenInclude;

export type ScreenRow = Prisma.ScreenGetPayload<{ include: typeof screenInclude }>;

export const screensRepository = {
  list: (where: Prisma.ScreenWhereInput, skip: number, take: number) =>
    Promise.all([prisma.screen.findMany({ where, include: screenInclude, orderBy: { createdAt: "asc" }, skip, take }), prisma.screen.count({ where })]),
  findScoped: (companyId: string | undefined, id: string, tx?: Tx) => (tx ?? prisma).screen.findFirst({ where: { id, ...(companyId ? { companyId } : {}) }, include: screenInclude }),
  update: (id: string, data: Prisma.ScreenUncheckedUpdateInput, tx?: Tx) => (tx ?? prisma).screen.update({ where: { id }, data, include: screenInclude }),
  setGroups: async (screenId: string, groupIds: string[], tx?: Tx) => {
    const client = tx ?? prisma;
    await client.screenGroupMember.deleteMany({ where: { screenId } });
    if (groupIds.length) await client.screenGroupMember.createMany({ data: groupIds.map((groupId) => ({ groupId, screenId })), skipDuplicates: true });
  },

  // ---- pairing sessions ----
  createPairingSession: (data: Prisma.PairingSessionUncheckedCreateInput) => prisma.pairingSession.create({ data }),
  findPairingByCode: (code: string, tx: Tx) => tx.pairingSession.findUnique({ where: { code } }),
  consumePairing: (id: string, screenId: string, companyId: string, tx: Tx) => tx.pairingSession.update({ where: { id }, data: { status: "CONSUMED", consumedAt: new Date(), screenId, companyId } }),
  findDeviceByDeviceId: (deviceId: string, tx: Tx) => tx.screenDevice.findUnique({ where: { deviceId }, include: { screen: { select: { pairingStatus: true } } } }),
  findPairingBySession: (id: string) => prisma.pairingSession.findUnique({ where: { id } }),
  createScreen: (data: Prisma.ScreenUncheckedCreateInput, tx: Tx) => tx.screen.create({ data, include: screenInclude }),

  // ---- groups ----
  listGroups: (companyId: string) => prisma.screenGroup.findMany({ where: { companyId }, include: { members: { include: { screen: { select: { id: true, status: true } } } } }, orderBy: { name: "asc" } }),
  findGroup: (companyId: string, id: string) => prisma.screenGroup.findFirst({ where: { id, companyId }, include: { members: { include: { screen: { select: { id: true, status: true } } } } } }),
  createGroup: (data: Prisma.ScreenGroupUncheckedCreateInput) => prisma.screenGroup.create({ data, include: { members: { include: { screen: { select: { id: true, status: true } } } } } }),
  updateGroup: (id: string, data: Prisma.ScreenGroupUncheckedUpdateInput) => prisma.screenGroup.update({ where: { id }, data, include: { members: { include: { screen: { select: { id: true, status: true } } } } } }),
  deleteGroup: (id: string) => prisma.screenGroup.delete({ where: { id } }),
  setGroupMembers: async (groupId: string, screenIds: string[]) => {
    await prisma.screenGroupMember.deleteMany({ where: { groupId } });
    if (screenIds.length) await prisma.screenGroupMember.createMany({ data: screenIds.map((screenId) => ({ groupId, screenId })), skipDuplicates: true });
  },
  countScreensInCompany: (companyId: string, ids: string[]) => prisma.screen.count({ where: { companyId, id: { in: ids } } }),
};
