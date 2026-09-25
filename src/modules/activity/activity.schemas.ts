import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { dateTime, endAfterStart, id, optionalText } from "../../core/validation/fields.js";

/** Every `resourceType` the API writes to the activity log. */
export const activityResourceType = z.enum(["campaign", "canvas", "company", "layout", "license", "media", "notification", "offer", "playlist", "schedule", "screen", "screen_group", "template", "template_instance", "user", "winner"]);

export const listActivityQuery = paginationQuery
  .extend({
    /** Prefix match, so `screen` finds every `screen.*` action. */
    action: z.string().trim().max(80).regex(/^[a-z_.]*$/, "Use an action like screen.paired").transform((v) => v || undefined).optional(),
    resourceType: activityResourceType.optional(),
    status: z.enum(["SUCCESS", "PENDING", "FAILED"]).optional(),
    companyId: id().optional(),
    from: dateTime().optional(),
    to: dateTime().optional(),
    search: optionalText(100),
  })
  .superRefine(endAfterStart("from", "to"));
export const activityDto = z.object({ id: z.string(), action: z.string(), resourceType: z.string(), resourceId: z.string().nullable(), status: z.string(), summary: z.string(), meta: z.unknown().nullable(), company: z.object({ id: z.string(), name: z.string() }).nullable(), actor: z.object({ id: z.string(), name: z.string(), role: z.string() }).nullable(), createdAt: z.string() }).openapi("ActivityEntry");

registry.registerPath({ method: "get", path: "/activity", tags: ["Activity"], security: [{ bearerAuth: [] }], request: { query: listActivityQuery }, responses: { 200: jsonBody(envelope(z.array(activityDto))) } });
