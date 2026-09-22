import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const idParams = z.object({ id: z.string().min(1) });
export const audience = z.union([z.object({ kind: z.literal("all") }), z.object({ kind: z.literal("companies"), companyIds: z.array(z.string()).min(1) }), z.object({ kind: z.literal("users"), userIds: z.array(z.string()).min(1) })]);
export const notificationType = z.enum(["announcement", "offer", "campaign"]).openapi("NotificationType");
export const createNotificationBody = z
  .object({
    title: z.string().trim().min(2).max(120),
    body: z.string().trim().min(2).max(500),
    /** What the notification opens in the app; `offer` and `campaign` need `targetId`. */
    type: notificationType.default("announcement"),
    targetId: z.string().min(1).max(64).optional(),
    audience,
    /** HTTPS page for web push; phones use the `dsp://` link built from `type`/`targetId`. */
    deepLink: z.string().max(300).optional(),
    scheduledAt: z.string().datetime().optional(),
  })
  .refine((b) => b.type === "announcement" || !!b.targetId, { message: "targetId is required for offer and campaign notifications", path: ["targetId"] })
  .openapi("CreateNotificationBody");
export const subscribeBody = z.object({ externalId: z.string().min(4).max(200), platform: z.enum(["web", "android", "ios"]).optional() }).openapi("PushSubscribeBody");
export const listNotificationsQuery = paginationQuery;

export const notificationDto = z.object({ id: z.string(), title: z.string(), body: z.string(), type: notificationType, targetId: z.string().nullable(), audience, deepLink: z.string().nullable(), scheduledAt: z.string().nullable(), sentAt: z.string().nullable(), providerId: z.string().nullable(), createdAt: z.string() }).openapi("Notification");
/** What a recipient sees: no audience or delivery details. */
export const inboxItemDto = z.object({ id: z.string(), title: z.string(), body: z.string(), type: notificationType, targetId: z.string().nullable(), sentAt: z.string(), createdAt: z.string() }).openapi("InboxNotification");

const tag = ["Notifications"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/notifications", tags: tag, security: sec, request: { query: listNotificationsQuery }, responses: { 200: jsonBody(envelope(z.array(notificationDto))) } });
registry.registerPath({ method: "get", path: "/notifications/inbox", tags: tag, security: sec, description: "Sent notifications addressed to the caller (everyone, their company, or them), newest first.", request: { query: listNotificationsQuery }, responses: { 200: jsonBody(envelope(z.array(inboxItemDto))) } });
registry.registerPath({ method: "get", path: "/notifications/{id}", tags: tag, security: sec, description: "One notification, if the caller is in its audience (any, for the Super Admin).", request: { params: idParams }, responses: { 200: jsonBody(envelope(inboxItemDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/notifications", tags: tag, security: sec, request: { body: jsonBody(createNotificationBody) }, responses: { 202: jsonBody(envelope(notificationDto)), 403: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/notifications/subscriptions", tags: tag, security: sec, request: { body: jsonBody(subscribeBody) }, responses: { 201: jsonBody(envelope(z.object({ id: z.string(), externalId: z.string() }))) } });
registry.registerPath({ method: "delete", path: "/notifications/subscriptions/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Unsubscribed" } } });
