import { z } from "zod";
import { queryFlag } from "../../core/http/query.js";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const idParams = z.object({ id: z.string().min(1) });
export const targetKind = z.enum(["SCREEN", "GROUP"]);
export const listSchedulesQuery = paginationQuery.extend({ targetKind: targetKind.optional(), targetId: z.string().optional(), playlistId: z.string().optional(), activeOnly: queryFlag(false) });
export const activeQuery = z.object({ screenId: z.string().min(1), at: z.string().datetime().optional() });
const base = { playlistId: z.string().min(1), targetKind, targetId: z.string().min(1), startsAt: z.string().datetime(), endsAt: z.string().datetime().nullable().optional(), timezone: z.string().min(1).max(64).default("UTC") };
export const createScheduleBody = z.object(base).refine((b) => !b.endsAt || new Date(b.endsAt) > new Date(b.startsAt), { message: "endsAt must be after startsAt", path: ["endsAt"] }).openapi("CreateScheduleBody");
export const updateScheduleBody = z.object({ playlistId: base.playlistId.optional(), startsAt: base.startsAt.optional(), endsAt: base.endsAt, timezone: base.timezone.optional() }).openapi("UpdateScheduleBody");
export const checkConflictsBody = z.object(base).openapi("CheckConflictsBody");

export const scheduleDto = z.object({ id: z.string(), playlist: z.object({ id: z.string(), name: z.string() }), targetKind, targetId: z.string(), targetName: z.string(), startsAt: z.string(), endsAt: z.string().nullable(), timezone: z.string(), status: z.enum(["UPCOMING", "ACTIVE", "EXPIRED"]), createdAt: z.string() }).openapi("Schedule");
export const conflictDto = z.object({ conflicts: z.array(z.object({ scheduleId: z.string(), playlistName: z.string(), startsAt: z.string(), endsAt: z.string().nullable() })) }).openapi("ScheduleConflicts");
export const activeAssignmentDto = z.object({ screenId: z.string(), source: z.enum(["SCHEDULE_SCREEN", "SCHEDULE_GROUP", "ASSIGNMENT", "NONE"]), playlistId: z.string().nullable(), scheduleId: z.string().nullable(), assignment: z.object({ kind: z.string(), refId: z.string() }).nullable() }).openapi("ActiveAssignment");

const tag = ["Schedules"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/schedules", tags: tag, security: sec, request: { query: listSchedulesQuery }, responses: { 200: jsonBody(envelope(z.array(scheduleDto))) } });
registry.registerPath({ method: "post", path: "/schedules", tags: tag, security: sec, request: { body: jsonBody(createScheduleBody), headers: z.object({ "idempotency-key": z.string() }) }, responses: { 201: jsonBody(envelope(scheduleDto)), 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/schedules/check-conflicts", tags: tag, security: sec, request: { body: jsonBody(checkConflictsBody) }, responses: { 200: jsonBody(envelope(conflictDto)) } });
registry.registerPath({ method: "get", path: "/schedules/active", tags: tag, security: sec, request: { query: activeQuery }, responses: { 200: jsonBody(envelope(activeAssignmentDto)) } });
registry.registerPath({ method: "patch", path: "/schedules/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateScheduleBody) }, responses: { 200: jsonBody(envelope(scheduleDto)) } });
registry.registerPath({ method: "delete", path: "/schedules/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });
