import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";
import { getPushProvider } from "../core/push/index.js";
import type { PushMessage } from "../core/push/PushProvider.js";
import type { Notification } from "../generated/prisma/client.js";

type Audience = { kind: "all" } | { kind: "companies"; companyIds: string[] } | { kind: "users"; userIds: string[] };

/** The app's deep link scheme (R1): dsp://offers/<id>, dsp://campaigns/<id>, dsp://notifications/<id>. */
export function appLink(n: Pick<Notification, "id" | "type" | "targetId">): string {
  if (n.type === "offer" && n.targetId) return `dsp://offers/${n.targetId}`;
  if (n.type === "campaign" && n.targetId) return `dsp://campaigns/${n.targetId}`;
  return `dsp://notifications/${n.id}`;
}

/** Resolves the audience to push subscriptions and delivers through the configured provider. */
export async function notificationSend(data: { notificationId: string }): Promise<void> {
  const n = await prisma.notification.findUnique({ where: { id: data.notificationId } });
  if (!n || n.sentAt) return;
  const audience = n.audience as Audience;
  const where = audience.kind === "all" ? {} : audience.kind === "companies" ? { companyId: { in: audience.companyIds } } : { userId: { in: audience.userIds } };
  const subs = await prisma.pushSubscription.findMany({ where, select: { externalId: true } });
  const message: PushMessage = {
    title: n.title,
    body: n.body,
    data: { notificationId: n.id, type: n.type, ...(n.targetId ? { targetId: n.targetId } : {}) },
    appUrl: appLink(n),
    ...(n.deepLink?.startsWith("https://") ? { webUrl: n.deepLink } : {}),
    idempotencyKey: n.id,
  };
  const result = await getPushProvider().send(message, { externalIds: subs.map((s) => s.externalId) });
  if (result.invalidIds.length) await prisma.pushSubscription.deleteMany({ where: { externalId: { in: result.invalidIds } } });
  await prisma.notification.update({ where: { id: n.id }, data: { sentAt: new Date(), providerId: result.providerId } });
  logger.info({ notificationId: n.id, recipients: result.recipients, dropped: result.invalidIds.length, provider: getPushProvider().name }, "notification sent");
}
