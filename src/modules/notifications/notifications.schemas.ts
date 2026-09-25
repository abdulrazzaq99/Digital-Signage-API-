import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { dateTime, deepLink, id, list, notInPast, optionalField, text } from "../../core/validation/fields.js";

export const idParams = z.object({ id: id() });
export const audience = z.union([z.object({ kind: z.literal("all") }), z.object({ kind: z.literal("companies"), companyIds: z.array(z.string()).min(1) }), z.object({ kind: z.literal("users"), userIds: z.array(z.string()).min(1) })]);
/** Request form of `audience`: ids checked, at most 1000 companies or users. */
const audienceInput = z.union([
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("companies"), companyIds: list(id(), 1000, 1) }).strict(),
  z.object({ kind: z.literal("users"), userIds: list(id(), 1000, 1) }).strict(),
]);
export const notificationType = z.enum(["announcement", "offer", "campaign"]).openapi("NotificationType");
export const createNotificationBody = z
  .object({
    title: text(120, 2),
    body: text(500, 2),
    /** What the notification opens in the app; `offer` and `campaign` need `targetId`. */
    type: notificationType.default("announcement"),
    targetId: id().optional(),
    audience: audienceInput,
    /** App path (e.g. /portal/offers) or http(s) page for web push; phones use the `dsp://` link built from `type`/`targetId`. */
    deepLink: optionalField(deepLink()),
    scheduledAt: dateTime().refine(notInPast, "The send time can't be in the past").optional(),
  })
  .refine((b) => b.type === "announcement" || !!b.targetId, { message: "targetId is required for offer and campaign notifications", path: ["targetId"] })
  .openapi("CreateNotificationBody");
export const subscribeBody = z.object({ externalId: text(200, 4), platform: z.enum(["web", "android", "ios"]).optional() }).openapi("PushSubscribeBody");
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
