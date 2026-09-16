import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const idParams = z.object({ id: z.string().min(1) });
export const audience = z.union([z.object({ kind: z.literal("all") }), z.object({ kind: z.literal("companies"), companyIds: z.array(z.string()).min(1) }), z.object({ kind: z.literal("users"), userIds: z.array(z.string()).min(1) })]);
export const createNotificationBody = z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(500), audience, deepLink: z.string().max(300).optional(), scheduledAt: z.string().datetime().optional() }).openapi("CreateNotificationBody");
export const subscribeBody = z.object({ externalId: z.string().min(4).max(200), platform: z.enum(["web", "android", "ios"]).optional() }).openapi("PushSubscribeBody");
export const listNotificationsQuery = paginationQuery;

export const notificationDto = z.object({ id: z.string(), title: z.string(), body: z.string(), audience, deepLink: z.string().nullable(), scheduledAt: z.string().nullable(), sentAt: z.string().nullable(), providerId: z.string().nullable(), createdAt: z.string() }).openapi("Notification");

const tag = ["Notifications"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/notifications", tags: tag, security: sec, request: { query: listNotificationsQuery }, responses: { 200: jsonBody(envelope(z.array(notificationDto))) } });
registry.registerPath({ method: "post", path: "/notifications", tags: tag, security: sec, request: { body: jsonBody(createNotificationBody) }, responses: { 202: jsonBody(envelope(notificationDto)), 403: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/notifications/subscriptions", tags: tag, security: sec, request: { body: jsonBody(subscribeBody) }, responses: { 201: jsonBody(envelope(z.object({ id: z.string(), externalId: z.string() }))) } });
registry.registerPath({ method: "delete", path: "/notifications/subscriptions/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Unsubscribed" } } });
