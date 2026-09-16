import { prisma } from "../core/db/prisma.js";
import { logger } from "../core/middleware/logger.js";
import { getPushProvider } from "../core/push/index.js";

type Audience = { kind: "all" } | { kind: "companies"; companyIds: string[] } | { kind: "users"; userIds: string[] };

/** Resolves the audience to push subscriptions and delivers through the configured provider. */
export async function notificationSend(data: { notificationId: string }): Promise<void> {
  const n = await prisma.notification.findUnique({ where: { id: data.notificationId } });
  if (!n || n.sentAt) return;
  const audience = n.audience as Audience;
  const where = audience.kind === "all" ? {} : audience.kind === "companies" ? { companyId: { in: audience.companyIds } } : { userId: { in: audience.userIds } };
  const subs = await prisma.pushSubscription.findMany({ where, select: { externalId: true } });
  const result = await getPushProvider().send({ title: n.title, body: n.body, deepLink: n.deepLink ?? undefined, data: { notificationId: n.id } }, { externalIds: subs.map((s) => s.externalId) });
  await prisma.notification.update({ where: { id: n.id }, data: { sentAt: new Date(), providerId: result.providerId } });
  logger.info({ notificationId: n.id, recipients: result.recipients, provider: getPushProvider().name }, "notification sent");
}
