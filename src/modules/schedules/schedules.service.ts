import type { z } from "zod";
import { logActivity } from "../../core/audit/activity.js";
import { requireCompanyId, tenantWhere, type AuthUser, type TenantScope } from "../../core/auth/scope.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import { Events } from "../../core/realtime/events.js";
import { emitToScreen } from "../../core/realtime/server.js";
import { prisma } from "../../core/db/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { schedulesRepository as repo, type ScheduleRow } from "./schedules.repository.js";
import type { checkConflictsBody, createScheduleBody, listSchedulesQuery, updateScheduleBody } from "./schedules.schemas.js";

function statusOf(s: { startsAt: Date; endsAt: Date | null }, now = new Date()) {
  if (s.startsAt > now) return "UPCOMING" as const;
  if (s.endsAt && s.endsAt <= now) return "EXPIRED" as const;
  return "ACTIVE" as const;
}

async function toDto(s: ScheduleRow) {
  return { id: s.id, playlist: s.playlist, targetKind: s.targetKind, targetId: s.targetId, targetName: await repo.targetName(s.targetKind, s.targetId), startsAt: s.startsAt.toISOString(), endsAt: s.endsAt?.toISOString() ?? null, timezone: s.timezone, status: statusOf(s), createdAt: s.createdAt.toISOString() };
}

async function notifyTarget(kind: "SCREEN" | "GROUP", targetId: string) {
  const screenIds = kind === "SCREEN" ? [targetId] : (await prisma.screenGroupMember.findMany({ where: { groupId: targetId }, select: { screenId: true } })).map((m) => m.screenId);
  for (const id of screenIds) emitToScreen(id, Events.scheduleUpdated, { screenId: id, at: new Date().toISOString() });
}

export const schedulesService = {
  async list(scope: TenantScope, q: z.infer<typeof listSchedulesQuery>) {
    const now = new Date();
    const where: Prisma.ScheduleWhereInput = { ...tenantWhere(scope), ...(q.targetKind ? { targetKind: q.targetKind } : {}), ...(q.targetId ? { targetId: q.targetId } : {}), ...(q.playlistId ? { playlistId: q.playlistId } : {}), ...(q.activeOnly ? { startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] } : {}) };
    const { skip, take } = paginate(q);
    const [rows, total] = await repo.list(where, skip, take);
    return { data: await Promise.all(rows.map(toDto)), meta: pageMeta(q, total) };
  },

  async checkConflicts(scope: TenantScope, body: z.infer<typeof checkConflictsBody>, excludeId?: string) {
    const companyId = requireCompanyId(scope);
    const rows = await repo.overlapping(companyId, body.targetKind, body.targetId, new Date(body.startsAt), body.endsAt ? new Date(body.endsAt) : null, excludeId);
    return { conflicts: rows.map((r) => ({ scheduleId: r.id, playlistName: r.playlist.name, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt?.toISOString() ?? null })) };
  },

  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createScheduleBody>) {
    const companyId = requireCompanyId(scope);
    if (!(await repo.targetExists(companyId, body.targetKind, body.targetId))) throw new ValidationError("Target not found", undefined, "TARGET_NOT_FOUND");
    if (!(await prisma.playlist.count({ where: { id: body.playlistId, companyId } }))) throw new ValidationError("Playlist not found", undefined, "PLAYLIST_NOT_FOUND");
    const { conflicts } = await this.checkConflicts(scope, body);
    if (conflicts.length) throw new ConflictError("This schedule overlaps an existing schedule on the same target", "SCHEDULE_CONFLICT", { conflicts });
    const s = await repo.create({ companyId, playlistId: body.playlistId, targetKind: body.targetKind, targetId: body.targetId, startsAt: new Date(body.startsAt), endsAt: body.endsAt ? new Date(body.endsAt) : null, timezone: body.timezone });
    await logActivity({ companyId, actor, action: "schedule.created", resourceType: "schedule", resourceId: s.id, summary: `"${s.playlist.name}" scheduled for ${await repo.targetName(s.targetKind, s.targetId)}` });
    await notifyTarget(s.targetKind, s.targetId);
    return toDto(s);
  },

  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateScheduleBody>) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Schedule");
    const startsAt = body.startsAt ? new Date(body.startsAt) : existing.startsAt;
    const endsAt = body.endsAt === undefined ? existing.endsAt : body.endsAt ? new Date(body.endsAt) : null;
    if (endsAt && endsAt <= startsAt) throw new ValidationError("endsAt must be after startsAt", undefined, "INVALID_WINDOW");
    const conflicts = await repo.overlapping(existing.companyId, existing.targetKind, existing.targetId, startsAt, endsAt, id);
    if (conflicts.length) throw new ConflictError("This schedule overlaps an existing schedule on the same target", "SCHEDULE_CONFLICT", { conflicts: conflicts.map((r) => ({ scheduleId: r.id, playlistName: r.playlist.name })) });
    const s = await repo.update(id, { playlistId: body.playlistId, startsAt, endsAt, timezone: body.timezone });
    await logActivity({ companyId: existing.companyId, actor, action: "schedule.updated", resourceType: "schedule", resourceId: id, summary: `Schedule for ${await repo.targetName(s.targetKind, s.targetId)} updated` });
    await notifyTarget(s.targetKind, s.targetId);
    return toDto(s);
  },

  async remove(actor: AuthUser, scope: TenantScope, id: string) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing) throw new NotFoundError("Schedule");
    await repo.delete(id);
    await logActivity({ companyId: existing.companyId, actor, action: "schedule.deleted", resourceType: "schedule", resourceId: id, summary: `Schedule for ${await repo.targetName(existing.targetKind, existing.targetId)} removed` });
    await notifyTarget(existing.targetKind, existing.targetId);
  },

  /** Precedence: explicit screen schedule → group schedule → the screen's published assignment. */
  async active(scope: TenantScope, screenId: string, at?: string) {
    const screen = await prisma.screen.findFirst({ where: { id: screenId, ...tenantWhere(scope) }, select: { id: true } });
    if (!screen) throw new NotFoundError("Screen");
    const { screenLevel, groupLevel, assignment } = await repo.activeFor(screenId, at ? new Date(at) : new Date());
    if (screenLevel) return { screenId, source: "SCHEDULE_SCREEN" as const, playlistId: screenLevel.playlistId, scheduleId: screenLevel.id, assignment: null };
    if (groupLevel) return { screenId, source: "SCHEDULE_GROUP" as const, playlistId: groupLevel.playlistId, scheduleId: groupLevel.id, assignment: null };
    if (assignment) return { screenId, source: "ASSIGNMENT" as const, playlistId: assignment.kind === "PLAYLIST" ? assignment.refId : null, scheduleId: null, assignment: { kind: assignment.kind, refId: assignment.refId } };
    return { screenId, source: "NONE" as const, playlistId: null, scheduleId: null, assignment: null };
  },
};
