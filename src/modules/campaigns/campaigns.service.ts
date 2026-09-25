import type { z } from "zod";
import { assertImageKey } from "../../core/assignments/refs.js";
import { logActivity } from "../../core/audit/activity.js";
import type { AuthUser, TenantScope } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { withTransaction, type Tx } from "../../core/db/transaction.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import { assertNameFree } from "../../core/validation/names.js";
import { presignGet } from "../../core/storage/s3.js";
import type { Prisma, ScratchCampaign, ScratchPrize } from "../../generated/prisma/client.js";
import type { addPrizeBody, createCampaignBody, listCampaignsQuery, listWinnersQuery, updateCampaignBody } from "./campaigns.schemas.js";

interface Allocation { loseWeight: number; prizes: { prizeId: string; weight: number }[] }
type CampaignRow = ScratchCampaign & { prizes: ScratchPrize[] };

function requirePlatform(scope: TenantScope) {
  if (scope.kind !== "platform") throw new ForbiddenError("Only the Super Admin can manage campaigns", "PLATFORM_ONLY");
}

/** Effective status: DRAFT/INACTIVE stay as stored; ACTIVE resolves against the window. */
function effectiveStatus(c: ScratchCampaign, now = new Date()) {
  if (c.status === "DRAFT" || c.status === "INACTIVE") return c.status;
  if (now < c.startsAt) return "SCHEDULED" as const;
  if (now > c.endsAt) return "ENDED" as const;
  return "ACTIVE" as const;
}

async function toDto(c: CampaignRow, withCounts: boolean) {
  const counts = withCounts ? await Promise.all([prisma.scratchAttempt.count({ where: { campaignId: c.id } }), prisma.scratchWinner.count({ where: { attempt: { campaignId: c.id } } })]) : null;
  return {
    id: c.id, title: c.title, description: c.description, status: effectiveStatus(c), startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(), maxAttempts: c.maxAttempts, requireOffersVisit: c.requireOffersVisit,
    artworkUrl: c.artworkKey ? await presignGet(c.artworkKey) : null,
    prizes: c.prizes.map((p) => ({ id: p.id, name: p.name, value: p.value, quantity: p.quantity, remaining: p.remaining, awarded: p.quantity - p.remaining })),
    ...(counts ? { attempts: counts[0], winners: counts[1] } : {}), createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
  };
}

const include = { prizes: { orderBy: { createdAt: "asc" as const } } };

async function findCampaign(id: string): Promise<CampaignRow> {
  const c = await prisma.scratchCampaign.findUnique({ where: { id }, include });
  if (!c) throw new NotFoundError("Campaign");
  return c;
}

/** Weighted pick among candidates; returns null for a losing draw. Probability rules never leave the server. */
function draw(alloc: Allocation, availablePrizeIds: Set<string>, random = Math.random): string | null {
  const entries = alloc.prizes.filter((p) => availablePrizeIds.has(p.prizeId));
  const total = alloc.loseWeight + entries.reduce((a, p) => a + p.weight, 0);
  if (total <= 0) return null;
  let r = random() * total;
  for (const p of entries) {
    if (r < p.weight) return p.prizeId;
    r -= p.weight;
  }
  return null;
}

export const campaignsService = {
  async list(scope: TenantScope, q: z.infer<typeof listCampaignsQuery>) {
    const platform = scope.kind === "platform";
    const now = new Date();
    const where: Prisma.ScratchCampaignWhereInput = platform ? { ...(q.search ? { title: { contains: q.search, mode: "insensitive" } } : {}) } : { status: "ACTIVE", startsAt: { lte: now }, endsAt: { gte: now } };
    const { skip, take } = paginate(q);
    const [rows, total] = await Promise.all([prisma.scratchCampaign.findMany({ where, include, orderBy: { startsAt: "desc" }, skip, take }), prisma.scratchCampaign.count({ where })]);
    const data = await Promise.all(rows.map((c) => toDto(c, platform)));
    return { data: q.status && platform ? data.filter((d) => d.status === q.status) : data, meta: pageMeta(q, total) };
  },

  async get(scope: TenantScope, id: string) {
    const c = await findCampaign(id);
    if (scope.kind !== "platform" && effectiveStatus(c) !== "ACTIVE") throw new NotFoundError("Campaign");
    return toDto(c, scope.kind === "platform");
  },

  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createCampaignBody>) {
    requirePlatform(scope);
    if (body.artworkKey) await assertImageKey(body.artworkKey, scope.companyId, "body.artworkKey");
    await assertNameFree("campaign", body.title);
    const c = await withTransaction(async (tx) => {
      const created = await tx.scratchCampaign.create({ data: { title: body.title, description: body.description, status: body.activate ? "ACTIVE" : "DRAFT", startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt), maxAttempts: body.maxAttempts, requireOffersVisit: body.requireOffersVisit, artworkKey: body.artworkKey, allocation: { loseWeight: body.loseWeight, prizes: [] }, prizes: { create: body.prizes.map((p) => ({ name: p.name, value: p.value, quantity: p.quantity, remaining: p.quantity })) } }, include });
      const allocation: Allocation = { loseWeight: body.loseWeight, prizes: created.prizes.map((p, i) => ({ prizeId: p.id, weight: body.prizes[i]!.weight })) };
      return tx.scratchCampaign.update({ where: { id: created.id }, data: { allocation: allocation as unknown as Prisma.InputJsonValue }, include });
    });
    await logActivity({ actor, action: "campaign.created", resourceType: "campaign", resourceId: c.id, summary: `Campaign "${c.title}" created with ${c.prizes.length} prizes${body.activate ? " and activated" : ""}` });
    return toDto(c, true);
  },

  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateCampaignBody>) {
    requirePlatform(scope);
    const existing = await findCampaign(id);
    if (body.artworkKey && body.artworkKey !== existing.artworkKey) await assertImageKey(body.artworkKey, scope.companyId, "body.artworkKey");
    await assertNameFree("campaign", body.title, { excludeId: id });
    const startsAt = body.startsAt ? new Date(body.startsAt) : existing.startsAt;
    const endsAt = body.endsAt ? new Date(body.endsAt) : existing.endsAt;
    if (endsAt <= startsAt) throw new ValidationError("endsAt must be after startsAt", undefined, "INVALID_WINDOW");
    const allocation = existing.allocation as unknown as Allocation;
    const c = await prisma.scratchCampaign.update({ where: { id }, data: { title: body.title, description: body.description, startsAt, endsAt, maxAttempts: body.maxAttempts, requireOffersVisit: body.requireOffersVisit, artworkKey: body.artworkKey, ...(body.loseWeight !== undefined ? { allocation: { ...allocation, loseWeight: body.loseWeight } as unknown as Prisma.InputJsonValue } : {}) }, include });
    await logActivity({ actor, action: "campaign.updated", resourceType: "campaign", resourceId: id, summary: `Campaign "${c.title}" updated`, meta: { fields: Object.keys(body) } });
    return toDto(c, true);
  },

  async setActive(actor: AuthUser, scope: TenantScope, id: string, active: boolean) {
    requirePlatform(scope);
    const existing = await findCampaign(id);
    if (active && !existing.prizes.length) throw new ValidationError("Add at least one prize before activating", undefined, "NO_PRIZES");
    const c = await prisma.scratchCampaign.update({ where: { id }, data: { status: active ? "ACTIVE" : "INACTIVE" }, include });
    await logActivity({ actor, action: active ? "campaign.activated" : "campaign.deactivated", resourceType: "campaign", resourceId: id, summary: `Campaign "${c.title}" ${active ? "activated" : "deactivated"}` });
    return toDto(c, true);
  },

  async addPrize(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof addPrizeBody>) {
    requirePlatform(scope);
    const existing = await findCampaign(id);
    const c = await withTransaction(async (tx) => {
      const prize = await tx.scratchPrize.create({ data: { campaignId: id, name: body.name, value: body.value, quantity: body.quantity, remaining: body.quantity } });
      const allocation = existing.allocation as unknown as Allocation;
      return tx.scratchCampaign.update({ where: { id }, data: { allocation: { ...allocation, prizes: [...allocation.prizes, { prizeId: prize.id, weight: body.weight }] } as unknown as Prisma.InputJsonValue }, include });
    });
    await logActivity({ actor, action: "campaign.prize_added", resourceType: "campaign", resourceId: id, summary: `Prize "${body.name}" (${body.quantity}) added to "${c.title}"` });
    return toDto(c, true);
  },

  async removePrize(actor: AuthUser, scope: TenantScope, id: string, prizeId: string) {
    requirePlatform(scope);
    const existing = await findCampaign(id);
    const prize = existing.prizes.find((p) => p.id === prizeId);
    if (!prize) throw new NotFoundError("Prize");
    if (prize.remaining !== prize.quantity) throw new ConflictError("Prizes that have already been awarded cannot be removed", "PRIZE_AWARDED");
    const allocation = existing.allocation as unknown as Allocation;
    const c = await withTransaction(async (tx) => {
      await tx.scratchPrize.delete({ where: { id: prizeId } });
      return tx.scratchCampaign.update({ where: { id }, data: { allocation: { ...allocation, prizes: allocation.prizes.filter((p) => p.prizeId !== prizeId) } as unknown as Prisma.InputJsonValue }, include });
    });
    await logActivity({ actor, action: "campaign.prize_removed", resourceType: "campaign", resourceId: id, summary: `Prize "${prize.name}" removed from "${c.title}"` });
    return toDto(c, true);
  },

  async eligibility(actor: AuthUser, id: string) {
    const c = await findCampaign(id);
    const attempts = await prisma.scratchAttempt.findMany({ where: { campaignId: id, userId: actor.id }, orderBy: { createdAt: "desc" }, include: { prize: true, winner: { select: { redemption: true } } } });
    const attemptsUsed = attempts.length;
    const reason = await eligibilityReason(c, actor, attemptsUsed);
    return {
      eligible: !reason,
      reason,
      attemptsUsed,
      attemptsRemaining: Math.max(0, c.maxAttempts - attemptsUsed),
      attempts: attempts.map((a) => ({ attemptId: a.id, outcome: a.outcome, prize: a.prize ? { id: a.prize.id, name: a.prize.name, value: a.prize.value } : null, redemption: a.winner?.redemption ?? null, createdAt: a.createdAt.toISOString() })),
    };
  },

  /**
   * Server-decided scratch result. The whole thing runs in one transaction with the chosen
   * prize row locked, so concurrent attempts can never over-award. Idempotency-Key makes
   * retries return the original outcome.
   */
  async attempt(actor: AuthUser, id: string, idempotencyKey: string) {
    const key = `${actor.id}:${idempotencyKey}`;
    const existing = await prisma.scratchAttempt.findUnique({ where: { idempotencyKey: key }, include: { prize: true } });
    if (existing) {
      const used = await prisma.scratchAttempt.count({ where: { campaignId: id, userId: actor.id } });
      const c = await findCampaign(id);
      return { attemptId: existing.id, outcome: existing.outcome, prize: existing.prize ? { id: existing.prize.id, name: existing.prize.name, value: existing.prize.value } : null, attemptsRemaining: Math.max(0, c.maxAttempts - used) };
    }
    return withTransaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ScratchCampaign" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows.length) throw new NotFoundError("Campaign");
      const c = await tx.scratchCampaign.findUnique({ where: { id }, include });
      const attemptsUsed = await tx.scratchAttempt.count({ where: { campaignId: id, userId: actor.id } });
      const reason = await eligibilityReason(c!, actor, attemptsUsed, tx);
      if (reason) throw reason === "ATTEMPTS_EXHAUSTED" ? new ConflictError("All attempts have been used", "ATTEMPTS_EXHAUSTED") : reason === "OFFERS_VISIT_REQUIRED" ? new ForbiddenError("View an offer in the Marketplace before scratching", "OFFERS_VISIT_REQUIRED") : new ConflictError("Campaign is not active", "CAMPAIGN_INACTIVE");

      const available = new Set(c!.prizes.filter((p) => p.remaining > 0).map((p) => p.id));
      let prizeId = draw(c!.allocation as unknown as Allocation, available);
      let prize: ScratchPrize | null = null;
      if (prizeId) {
        const locked = await tx.$queryRaw<{ id: string; remaining: number }[]>`SELECT "id", "remaining" FROM "ScratchPrize" WHERE "id" = ${prizeId} FOR UPDATE`;
        if (locked[0] && locked[0].remaining > 0) {
          await tx.scratchPrize.update({ where: { id: prizeId }, data: { remaining: { decrement: 1 } } });
          prize = c!.prizes.find((p) => p.id === prizeId)!;
        } else {
          prizeId = null;
        }
      }
      const attempt = await tx.scratchAttempt.create({ data: { campaignId: id, userId: actor.id, companyId: actor.companyId, idempotencyKey: key, outcome: prize ? "WIN" : "LOSE", prizeId: prize?.id ?? null } });
      if (prize) await tx.scratchWinner.create({ data: { attemptId: attempt.id, prizeId: prize.id, userId: actor.id } });
      await logActivity({ companyId: actor.companyId, actor, action: prize ? "campaign.win" : "campaign.attempt", resourceType: "campaign", resourceId: id, summary: prize ? `${actor.name} won "${prize.name}" in ${c!.title}` : `${actor.name} scratched in ${c!.title} (no prize)` }, tx);
      return { attemptId: attempt.id, outcome: attempt.outcome, prize: prize ? { id: prize.id, name: prize.name, value: prize.value } : null, attemptsRemaining: Math.max(0, c!.maxAttempts - attemptsUsed - 1) };
    });
  },

  async listWinners(scope: TenantScope, q: z.infer<typeof listWinnersQuery>) {
    requirePlatform(scope);
    const where: Prisma.ScratchWinnerWhereInput = { ...(q.campaignId ? { attempt: { campaignId: q.campaignId } } : {}), ...(q.companyId ? { attempt: { companyId: q.companyId } } : {}), ...(q.redemption ? { redemption: q.redemption } : {}), ...(q.search ? { user: { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { email: { contains: q.search, mode: "insensitive" } }] } } : {}) };
    const { skip, take } = paginate(q);
    const [rows, total] = await Promise.all([prisma.scratchWinner.findMany({ where, include: { user: { select: { id: true, name: true, email: true } }, prize: true, attempt: { include: { campaign: { select: { id: true, title: true } }, company: { select: { id: true, name: true } } } } }, orderBy: { createdAt: "desc" }, skip, take }), prisma.scratchWinner.count({ where })]);
    return { data: rows.map(toWinnerDto), meta: pageMeta(q, total) };
  },

  /** Idempotent: redeeming twice returns the same record. */
  async redeem(actor: AuthUser, scope: TenantScope, id: string) {
    requirePlatform(scope);
    const w = await prisma.scratchWinner.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, email: true } }, prize: true, attempt: { include: { campaign: { select: { id: true, title: true } }, company: { select: { id: true, name: true } } } } } });
    if (!w) throw new NotFoundError("Winner");
    if (w.redemption === "REDEEMED") return toWinnerDto(w);
    const updated = await prisma.scratchWinner.update({ where: { id }, data: { redemption: "REDEEMED", redeemedAt: new Date() }, include: { user: { select: { id: true, name: true, email: true } }, prize: true, attempt: { include: { campaign: { select: { id: true, title: true } }, company: { select: { id: true, name: true } } } } } });
    await logActivity({ companyId: w.attempt.companyId, actor, action: "campaign.redeemed", resourceType: "winner", resourceId: id, summary: `${w.prize.name} redeemed for ${w.user.name}` });
    return toWinnerDto(updated);
  },
};

async function eligibilityReason(c: CampaignRow, actor: AuthUser, attemptsUsed: number, tx: Tx | typeof prisma = prisma): Promise<string | null> {
  if (effectiveStatus(c) !== "ACTIVE") return "CAMPAIGN_INACTIVE";
  if (attemptsUsed >= c.maxAttempts) return "ATTEMPTS_EXHAUSTED";
  if (c.requireOffersVisit) {
    const viewed = await tx.offerView.count({ where: { userId: actor.id, viewedAt: { gte: c.startsAt } } });
    if (!viewed) return "OFFERS_VISIT_REQUIRED";
  }
  return null;
}

type WinnerRow = Prisma.ScratchWinnerGetPayload<{ include: { user: { select: { id: true; name: true; email: true } }; prize: true; attempt: { include: { campaign: { select: { id: true; title: true } }; company: { select: { id: true; name: true } } } } } }>;
function toWinnerDto(w: WinnerRow) {
  return { id: w.id, user: w.user, company: w.attempt.company, campaign: w.attempt.campaign, prize: { id: w.prize.id, name: w.prize.name, value: w.prize.value }, wonAt: w.createdAt.toISOString(), redemption: w.redemption, redeemedAt: w.redeemedAt?.toISOString() ?? null };
}
