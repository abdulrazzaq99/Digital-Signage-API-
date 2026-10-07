import type { z } from "zod";
import { logActivity } from "../../core/audit/activity.js";
import type { AuthUser } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { ConflictError, NotFoundError } from "../../core/errors/AppError.js";
import { assertNameFree } from "../../core/validation/names.js";
import type { categoryBody } from "./categories.schemas.js";

type Row = { id: string; name: string; createdAt: Date; _count: { companies: number } };
const toDto = (c: Row) => ({ id: c.id, name: c.name, companies: c._count.companies, createdAt: c.createdAt.toISOString() });
const withCount = { _count: { select: { companies: true } } } as const;

/** Offers, templates, campaigns and notifications whose audience names the category. */
async function contentUsing(categoryId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ kind: string; n: number }[]>`
    SELECT 'offer' AS kind, COUNT(*)::int AS n FROM "Offer" WHERE "audience"->'categoryIds' ? ${categoryId}
    UNION ALL SELECT 'template', COUNT(*)::int FROM "Template" WHERE "audience"->'categoryIds' ? ${categoryId}
    UNION ALL SELECT 'campaign', COUNT(*)::int FROM "ScratchCampaign" WHERE "audience"->'categoryIds' ? ${categoryId}
    UNION ALL SELECT 'pushed item', COUNT(*)::int FROM "Broadcast" WHERE "audience"->'categoryIds' ? ${categoryId}
    UNION ALL SELECT 'scheduled notification', COUNT(*)::int FROM "Notification" WHERE "sentAt" IS NULL AND "audience"->'categoryIds' ? ${categoryId}`;
  return rows.filter((r) => r.n > 0).map((r) => `${r.n} ${r.kind}${r.n > 1 ? "s" : ""}`);
}

export const categoriesService = {
  async list() {
    return (await prisma.locationCategory.findMany({ include: withCount, orderBy: { name: "asc" } })).map(toDto);
  },

  async create(actor: AuthUser, body: z.infer<typeof categoryBody>) {
    await assertNameFree("category", body.name);
    const c = await prisma.locationCategory.create({ data: { name: body.name }, include: withCount });
    await logActivity({ actor, action: "category.created", resourceType: "category", resourceId: c.id, summary: `Location category "${c.name}" added` });
    return toDto(c);
  },

  async rename(actor: AuthUser, id: string, body: z.infer<typeof categoryBody>) {
    const existing = await prisma.locationCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Category");
    await assertNameFree("category", body.name, { excludeId: id });
    const c = await prisma.locationCategory.update({ where: { id }, data: { name: body.name }, include: withCount });
    if (c.name !== existing.name) await logActivity({ actor, action: "category.renamed", resourceType: "category", resourceId: id, summary: `Location category "${existing.name}" renamed to "${c.name}"` });
    return toDto(c);
  },

  /** Refused while any location is in it or any content is aimed at it, so nothing silently loses its audience. */
  async remove(actor: AuthUser, id: string) {
    const c = await prisma.locationCategory.findUnique({ where: { id }, include: withCount });
    if (!c) throw new NotFoundError("Category");
    const used = [...(c._count.companies ? [`${c._count.companies} location${c._count.companies > 1 ? "s" : ""}`] : []), ...(await contentUsing(id))];
    if (used.length) throw new ConflictError(`"${c.name}" is used by ${used.join(", ")}. Move them to another category first.`, "CATEGORY_IN_USE", { usedBy: used });
    await prisma.locationCategory.delete({ where: { id } });
    await logActivity({ actor, action: "category.deleted", resourceType: "category", resourceId: id, summary: `Location category "${c.name}" deleted` });
  },
};
