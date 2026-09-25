import type { z } from "zod";
import { OFFER_VIEW_WINDOW_MIN } from "../../config/constants.js";
import { assertImageKey } from "../../core/assignments/refs.js";
import { logActivity } from "../../core/audit/activity.js";
import type { AuthUser, TenantScope } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { ForbiddenError, NotFoundError } from "../../core/errors/AppError.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import { assertNameFree } from "../../core/validation/names.js";
import { Events } from "../../core/realtime/events.js";
import { getIo } from "../../core/realtime/server.js";
import { presignGet } from "../../core/storage/s3.js";
import type { Offer, Prisma } from "../../generated/prisma/client.js";
import type { createOfferBody, listOffersQuery, updateOfferBody } from "./offers.schemas.js";

function requirePlatform(scope: TenantScope) {
  if (scope.kind !== "platform") throw new ForbiddenError("Only the Super Admin can manage offers", "PLATFORM_ONLY");
}

/** Customers see PUBLISHED offers inside their visibility window. */
function visibleWhere(now = new Date()): Prisma.OfferWhereInput {
  return { status: "PUBLISHED", AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] };
}

async function stats(offerId: string) {
  const [totalViews, unique, last] = await Promise.all([
    prisma.offerView.count({ where: { offerId } }),
    prisma.offerView.findMany({ where: { offerId }, distinct: ["userId"], select: { userId: true } }),
    prisma.offerView.findFirst({ where: { offerId }, orderBy: { viewedAt: "desc" }, select: { viewedAt: true } }),
  ]);
  return { totalViews, uniqueViewers: unique.length, lastViewedAt: last?.viewedAt.toISOString() ?? null };
}

async function toDto(o: Offer, withStats: boolean) {
  return {
    id: o.id, title: o.title, category: o.category, status: o.status, summary: o.summary, description: o.description, instructions: o.instructions, contact: o.contact as Record<string, string>, included: o.included, steps: o.steps,
    imageUrl: o.imageKey ? await presignGet(o.imageKey) : null, startsAt: o.startsAt?.toISOString() ?? null, endsAt: o.endsAt?.toISOString() ?? null, publishedAt: o.publishedAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
    ...(withStats ? { stats: await stats(o.id) } : {}),
  };
}

export const offersService = {
  async list(scope: TenantScope, q: z.infer<typeof listOffersQuery>) {
    const platform = scope.kind === "platform";
    const where: Prisma.OfferWhereInput = { ...(platform ? (q.status ? { status: q.status } : {}) : visibleWhere()), ...(q.category ? { category: q.category } : {}), ...(q.search ? { title: { contains: q.search, mode: "insensitive" } } : {}) };
    const { skip, take } = paginate(q);
    const [rows, total] = await Promise.all([prisma.offer.findMany({ where, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }], skip, take }), prisma.offer.count({ where })]);
    return { data: await Promise.all(rows.map((o) => toDto(o, platform))), meta: pageMeta(q, total) };
  },

  async get(scope: TenantScope, id: string) {
    const platform = scope.kind === "platform";
    const o = await prisma.offer.findFirst({ where: { id, ...(platform ? {} : visibleWhere()) } });
    if (!o) throw new NotFoundError("Offer");
    return toDto(o, platform);
  },

  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createOfferBody>) {
    requirePlatform(scope);
    if (body.imageKey) await assertImageKey(body.imageKey, scope.companyId, "body.imageKey");
    await assertNameFree("offer", body.title);
    const o = await prisma.offer.create({ data: { ...body, startsAt: body.startsAt ? new Date(body.startsAt) : null, endsAt: body.endsAt ? new Date(body.endsAt) : null } });
    await logActivity({ actor, action: "offer.created", resourceType: "offer", resourceId: o.id, summary: `Offer "${o.title}" created as draft` });
    return toDto(o, true);
  },

  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateOfferBody>) {
    requirePlatform(scope);
    const existing = await prisma.offer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Offer");
    if (body.imageKey && body.imageKey !== existing.imageKey) await assertImageKey(body.imageKey, scope.companyId, "body.imageKey");
    await assertNameFree("offer", body.title, { excludeId: id });
    const o = await prisma.offer.update({ where: { id }, data: { ...body, startsAt: body.startsAt === undefined ? undefined : body.startsAt ? new Date(body.startsAt) : null, endsAt: body.endsAt === undefined ? undefined : body.endsAt ? new Date(body.endsAt) : null } });
    await logActivity({ actor, action: "offer.updated", resourceType: "offer", resourceId: id, summary: `Offer "${o.title}" updated${existing.status === "PUBLISHED" ? " while live" : ""}` });
    return toDto(o, true);
  },

  async setPublished(actor: AuthUser, scope: TenantScope, id: string, publish: boolean) {
    requirePlatform(scope);
    const existing = await prisma.offer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Offer");
    const o = await prisma.offer.update({ where: { id }, data: publish ? { status: "PUBLISHED", publishedAt: existing.publishedAt ?? new Date() } : { status: "UNPUBLISHED" } });
    await logActivity({ actor, action: publish ? "offer.published" : "offer.unpublished", resourceType: "offer", resourceId: id, summary: `Offer "${o.title}" ${publish ? "published to the Marketplace" : "unpublished"}` });
    // Every `/app` socket (customers and the Super Admin) gets the event once.
    if (publish) getIo()?.of("/app").emit(Events.offerPublished, { offerId: o.id, title: o.title });
    return toDto(o, true);
  },

  /** One view per user per window (spec 11.2: repeated re-renders must not count). */
  async recordView(actor: AuthUser, scope: TenantScope, id: string) {
    const o = await prisma.offer.findFirst({ where: { id, ...(scope.kind === "platform" ? {} : visibleWhere()) }, select: { id: true } });
    if (!o) throw new NotFoundError("Offer");
    const since = new Date(Date.now() - OFFER_VIEW_WINDOW_MIN * 60_000);
    const recent = await prisma.offerView.findFirst({ where: { offerId: id, userId: actor.id, viewedAt: { gte: since } }, select: { id: true } });
    if (recent) return { recorded: false };
    await prisma.offerView.create({ data: { offerId: id, userId: actor.id, companyId: actor.companyId } });
    return { recorded: true };
  },

  async stats(scope: TenantScope, id: string) {
    requirePlatform(scope);
    if (!(await prisma.offer.count({ where: { id } }))) throw new NotFoundError("Offer");
    const byCompany = await prisma.offerView.groupBy({ by: ["companyId"], where: { offerId: id }, _count: { _all: true } });
    return { ...(await stats(id)), byCompany: byCompany.map((b) => ({ companyId: b.companyId, views: b._count._all })) };
  },

  async remove(actor: AuthUser, scope: TenantScope, id: string) {
    requirePlatform(scope);
    const existing = await prisma.offer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Offer");
    await prisma.offer.delete({ where: { id } });
    await logActivity({ actor, action: "offer.deleted", resourceType: "offer", resourceId: id, summary: `Offer "${existing.title}" deleted with its statistics` });
  },
};
