import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const listActivityQuery = paginationQuery.extend({
  action: z.string().max(80).optional(),
  resourceType: z.string().max(40).optional(),
  status: z.enum(["SUCCESS", "PENDING", "FAILED"]).optional(),
  companyId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().trim().max(100).optional(),
});
export const activityDto = z.object({ id: z.string(), action: z.string(), resourceType: z.string(), resourceId: z.string().nullable(), status: z.string(), summary: z.string(), meta: z.unknown().nullable(), company: z.object({ id: z.string(), name: z.string() }).nullable(), actor: z.object({ id: z.string(), name: z.string(), role: z.string() }).nullable(), createdAt: z.string() }).openapi("ActivityEntry");

registry.registerPath({ method: "get", path: "/activity", tags: ["Activity"], security: [{ bearerAuth: [] }], request: { query: listActivityQuery }, responses: { 200: jsonBody(envelope(z.array(activityDto))) } });
