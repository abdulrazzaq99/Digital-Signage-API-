import { prisma } from "../../core/db/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const scheduleInclude = { playlist: { select: { id: true, name: true } } } satisfies Prisma.ScheduleInclude;
export type ScheduleRow = Prisma.ScheduleGetPayload<{ include: typeof scheduleInclude }>;

export const schedulesRepository = {
  list: (where: Prisma.ScheduleWhereInput, skip: number, take: number) => Promise.all([prisma.schedule.findMany({ where, include: scheduleInclude, orderBy: { startsAt: "asc" }, skip, take }), prisma.schedule.count({ where })]),
  findScoped: (companyId: string | undefined, id: string) => prisma.schedule.findFirst({ where: { id, ...(companyId ? { companyId } : {}) }, include: scheduleInclude }),
  create: (data: Prisma.ScheduleUncheckedCreateInput) => prisma.schedule.create({ data, include: scheduleInclude }),
  update: (id: string, data: Prisma.ScheduleUncheckedUpdateInput) => prisma.schedule.update({ where: { id }, data, include: scheduleInclude }),
  delete: (id: string) => prisma.schedule.delete({ where: { id } }),
  /** Schedules on the same target whose window overlaps [startsAt, endsAt). Open-ended windows overlap everything after their start. */
  overlapping: (companyId: string, targetKind: "SCREEN" | "GROUP", targetId: string, startsAt: Date, endsAt: Date | null, excludeId?: string) =>
    prisma.schedule.findMany({
      where: {
        companyId, targetKind, targetId, ...(excludeId ? { id: { not: excludeId } } : {}),
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: startsAt } }] }, ...(endsAt ? [{ startsAt: { lt: endsAt } }] : [])],
      },
      include: scheduleInclude,
    }),
  targetName: async (kind: "SCREEN" | "GROUP", id: string) => (kind === "SCREEN" ? (await prisma.screen.findUnique({ where: { id }, select: { name: true } }))?.name : (await prisma.screenGroup.findUnique({ where: { id }, select: { name: true } }))?.name) ?? "Unknown",
  targetExists: (companyId: string, kind: "SCREEN" | "GROUP", id: string) => (kind === "SCREEN" ? prisma.screen.count({ where: { id, companyId, pairingStatus: "PAIRED" } }) : prisma.screenGroup.count({ where: { id, companyId } })),
  activeFor: async (screenId: string, at: Date) => {
    const groupIds = (await prisma.screenGroupMember.findMany({ where: { screenId }, select: { groupId: true } })).map((g) => g.groupId);
    const window = { startsAt: { lte: at }, OR: [{ endsAt: null }, { endsAt: { gt: at } }] };
    const [screenLevel, groupLevel, assignment] = await Promise.all([
      prisma.schedule.findFirst({ where: { targetKind: "SCREEN", targetId: screenId, ...window }, orderBy: { startsAt: "desc" } }),
      groupIds.length ? prisma.schedule.findFirst({ where: { targetKind: "GROUP", targetId: { in: groupIds }, ...window }, orderBy: { startsAt: "desc" } }) : null,
      prisma.screenAssignment.findUnique({ where: { screenId } }),
    ]);
    return { screenLevel, groupLevel, assignment };
  },
};
