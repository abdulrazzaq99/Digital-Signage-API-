import type { z } from "zod";
import { logActivity } from "../../core/audit/activity.js";
import type { AuthUser, TenantScope } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import { enqueue, JobNames } from "../../core/queue/queues.js";
import type { Notification, Prisma } from "../../generated/prisma/client.js";
import type { createNotificationBody, listNotificationsQuery, subscribeBody } from "./notifications.schemas.js";

function toDto(n: Notification) {
  return { id: n.id, title: n.title, body: n.body, type: n.type, targetId: n.targetId, audience: n.audience as z.infer<typeof createNotificationBody>["audience"], deepLink: n.deepLink, scheduledAt: n.scheduledAt?.toISOString() ?? null, sentAt: n.sentAt?.toISOString() ?? null, providerId: n.providerId, createdAt: n.createdAt.toISOString() };
}

function toInboxDto(n: Notification) {
  return { id: n.id, title: n.title, body: n.body, type: n.type, targetId: n.targetId, sentAt: (n.sentAt ?? n.createdAt).toISOString(), createdAt: n.createdAt.toISOString() };
}

/** Sent notifications whose audience includes the user: everyone, their company, or them by ID. */
function addressedTo(user: AuthUser): Prisma.NotificationWhereInput {
  const kind = (k: string): Prisma.NotificationWhereInput => ({ audience: { path: ["kind"], equals: k } });
  return {
    sentAt: { not: null },
    OR: [
      kind("all"),
      ...(user.companyId ? [{ AND: [kind("companies"), { audience: { path: ["companyIds"], array_contains: [user.companyId] } }] }] : []),
      { AND: [kind("users"), { audience: { path: ["userIds"], array_contains: [user.id] } }] },
    ],
  };
}

export const notificationsService = {
  async list(scope: TenantScope, q: z.infer<typeof listNotificationsQuery>) {
    if (scope.kind !== "platform") throw new ForbiddenError("Only the Super Admin can view sent notifications", "PLATFORM_ONLY");
    const { skip, take } = paginate(q);
    const [rows, total] = await Promise.all([prisma.notification.findMany({ orderBy: { createdAt: "desc" }, skip, take }), prisma.notification.count()]);
    return { data: rows.map(toDto), meta: pageMeta(q, total) };
  },

  /** Creates the record and enqueues delivery (immediately or at `scheduledAt`). */
  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createNotificationBody>) {
    if (scope.kind !== "platform") throw new ForbiddenError("Only the Super Admin can send notifications", "PLATFORM_ONLY");
    const targetId = body.type === "announcement" ? null : body.targetId!;
    if (body.type === "offer" && !(await prisma.offer.count({ where: { id: targetId! } }))) throw new ValidationError("Offer not found", undefined, "TARGET_NOT_FOUND");
    if (body.type === "campaign" && !(await prisma.scratchCampaign.count({ where: { id: targetId! } }))) throw new ValidationError("Campaign not found", undefined, "TARGET_NOT_FOUND");
    const n = await prisma.notification.create({ data: { title: body.title, body: body.body, type: body.type, targetId, audience: body.audience, deepLink: body.deepLink, scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null } });
    const delay = n.scheduledAt ? Math.max(0, n.scheduledAt.getTime() - Date.now()) : 0;
    await enqueue(JobNames.notificationSend, { notificationId: n.id }, { delay });
    await logActivity({ actor, action: "notification.created", resourceType: "notification", resourceId: n.id, summary: `Notification "${n.title}" ${delay ? "scheduled" : "queued for sending"}` });
    return toDto(n);
  },

  async inbox(actor: AuthUser, q: z.infer<typeof listNotificationsQuery>) {
    const where = addressedTo(actor);
    const { skip, take } = paginate(q);
    const [rows, total] = await Promise.all([prisma.notification.findMany({ where, orderBy: { sentAt: "desc" }, skip, take }), prisma.notification.count({ where })]);
    return { data: rows.map(toInboxDto), meta: pageMeta(q, total) };
  },

  async get(actor: AuthUser, id: string) {
    const n = await prisma.notification.findFirst({ where: actor.platformRole === "SUPER_ADMIN" ? { id } : { AND: [{ id }, addressedTo(actor)] } });
    if (!n) throw new NotFoundError("Notification");
    return toInboxDto(n);
  },

  async subscribe(actor: AuthUser, body: z.infer<typeof subscribeBody>) {
    const sub = await prisma.pushSubscription.upsert({ where: { externalId: body.externalId }, update: { userId: actor.id, companyId: actor.companyId, platform: body.platform }, create: { userId: actor.id, companyId: actor.companyId, externalId: body.externalId, platform: body.platform } });
    return { id: sub.id, externalId: sub.externalId };
  },

  async unsubscribe(actor: AuthUser, id: string) {
    const sub = await prisma.pushSubscription.findFirst({ where: { id, userId: actor.id } });
    if (!sub) throw new NotFoundError("Subscription");
    await prisma.pushSubscription.delete({ where: { id } });
  },
};
