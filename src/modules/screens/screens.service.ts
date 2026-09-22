import { customAlphabet } from "nanoid";
import type { z } from "zod";
import { CREDENTIAL_RECLAIM_SEC, PAIRING_CODE_TTL_SEC } from "../../config/constants.js";
import { changeContent } from "../../core/assignments/content.js";
import { logActivity } from "../../core/audit/activity.js";
import { requireCompanyId, tenantWhere, type AuthUser, type TenantScope } from "../../core/auth/scope.js";
import { randomToken, sha256 } from "../../core/auth/tokens.js";
import { prisma } from "../../core/db/prisma.js";
import { withTransaction } from "../../core/db/transaction.js";
import { ConflictError, ForbiddenError, GoneError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { paginate, pageMeta } from "../../core/http/pagination.js";
import { Events } from "../../core/realtime/events.js";
import { emitToCompany, emitToScreen } from "../../core/realtime/server.js";
import { clearPresence } from "../../core/redis/presence.js";
import { presignGet } from "../../core/storage/s3.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { licensesRepository } from "../licenses/licenses.repository.js";
import { screensRepository as repo, type ScreenRow } from "./screens.repository.js";
import type { createGroupBody, listScreensQuery, pairBody, remoteCommandBody, updateGroupBody, updateScreenBody } from "./screens.schemas.js";

const pairingCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

type AssignmentSummary = { name: string; thumbnailUrl: string | null };
const summaryKey = (kind: string, refId: string) => `${kind}:${refId}`;

/**
 * Assignments reference playlists, layouts, template instances, or canvases polymorphically.
 * This resolves display data for a batch of screens with at most one query per kind.
 */
export async function resolveAssignments(rows: ScreenRow[]): Promise<Map<string, AssignmentSummary>> {
  const byKind = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.assignment) continue;
    if (!byKind.has(r.assignment.kind)) byKind.set(r.assignment.kind, new Set());
    byKind.get(r.assignment.kind)!.add(r.assignment.refId);
  }
  const ids = (kind: string) => [...(byKind.get(kind) ?? [])];
  const out = new Map<string, AssignmentSummary>();

  if (ids("PLAYLIST").length) {
    const playlists = await prisma.playlist.findMany({
      where: { id: { in: ids("PLAYLIST") } },
      select: { id: true, name: true, items: { orderBy: { position: "asc" }, take: 1, select: { asset: { select: { type: true, storageKey: true, derivatives: { take: 1, select: { storageKey: true } } } } } } },
    });
    for (const p of playlists) {
      const asset = p.items[0]?.asset;
      const key = asset?.derivatives[0]?.storageKey ?? (asset?.type === "IMAGE" ? asset.storageKey : undefined);
      out.set(summaryKey("PLAYLIST", p.id), { name: p.name, thumbnailUrl: key ? await presignGet(key) : null });
    }
  }
  if (ids("LAYOUT").length) {
    for (const l of await prisma.layout.findMany({ where: { id: { in: ids("LAYOUT") } }, select: { id: true, name: true } })) out.set(summaryKey("LAYOUT", l.id), { name: l.name, thumbnailUrl: null });
  }
  if (ids("TEMPLATE_INSTANCE").length) {
    for (const t of await prisma.templateInstance.findMany({ where: { id: { in: ids("TEMPLATE_INSTANCE") } }, select: { id: true, name: true, outputKey: true } })) {
      out.set(summaryKey("TEMPLATE_INSTANCE", t.id), { name: t.name, thumbnailUrl: t.outputKey ? await presignGet(t.outputKey) : null });
    }
  }
  if (ids("CANVAS").length) {
    for (const c of await prisma.canvasSet.findMany({ where: { id: { in: ids("CANVAS") } }, select: { id: true, name: true } })) out.set(summaryKey("CANVAS", c.id), { name: c.name, thumbnailUrl: null });
  }
  return out;
}

export function toScreenDto(s: ScreenRow, summaries: Map<string, AssignmentSummary> = new Map()) {
  const summary = s.assignment ? summaries.get(summaryKey(s.assignment.kind, s.assignment.refId)) : undefined;
  return {
    id: s.id, companyId: s.companyId, name: s.name, location: s.location, orientation: s.orientation, status: s.status, syncState: s.syncState, tags: s.tags, isPersonal: s.isPersonal,
    lastSeenAt: s.lastSeenAt?.toISOString() ?? null, manifestVersion: s.manifestVersion, ackVersion: s.ackVersion, createdAt: s.createdAt.toISOString(),
    groups: s.groups.map((m) => m.group),
    device: s.device ? { deviceId: s.device.deviceId, model: s.device.model, playerVersion: s.device.playerVersion, appVersion: s.device.appVersion, firmware: s.device.firmware, resolution: s.device.resolution, ip: s.device.ip } : null,
    assignment: s.assignment
      ? { kind: s.assignment.kind, refId: s.assignment.refId, version: s.assignment.version, publishedAt: s.assignment.publishedAt.toISOString(), name: summary?.name ?? "", thumbnailUrl: summary?.thumbnailUrl ?? null }
      : null,
  };
}

/** Single-screen convenience for the DTO with resolved assignment display data. */
export async function toScreenDtoAsync(s: ScreenRow) {
  return toScreenDto(s, await resolveAssignments([s]));
}

type GroupRow = NonNullable<Awaited<ReturnType<typeof repo.findGroup>>>;
function toGroupDto(g: GroupRow) {
  return { id: g.id, name: g.name, description: g.description, screenCount: g.members.length, onlineCount: g.members.filter((m) => m.screen.status === "ONLINE").length, screenIds: g.members.map((m) => m.screenId), createdAt: g.createdAt.toISOString() };
}

export const screensService = {
  async list(scope: TenantScope, q: z.infer<typeof listScreensQuery>) {
    const where: Prisma.ScreenWhereInput = {
      ...tenantWhere(scope),
      pairingStatus: "PAIRED",
      ...(q.status ? { status: q.status } : {}),
      ...(q.orientation ? { orientation: q.orientation } : {}),
      ...(q.personal !== undefined ? { isPersonal: q.personal } : {}),
      ...(q.groupId ? { groups: { some: { groupId: q.groupId } } } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { location: { contains: q.search, mode: "insensitive" } }] } : {}),
    };
    const { skip, take } = paginate(q);
    const [rows, total] = await repo.list(where, skip, take);
    const summaries = await resolveAssignments(rows);
    return { data: rows.map((r) => toScreenDto(r, summaries)), meta: pageMeta(q, total) };
  },

  async get(scope: TenantScope, id: string) {
    const s = await repo.findScoped(scope.companyId, id);
    if (!s || s.pairingStatus !== "PAIRED") throw new NotFoundError("Screen");
    return toScreenDtoAsync(s);
  },

  /** Called by the unpaired player to obtain a short-lived pairing code. */
  async createPairingSession(input: { deviceId: string; model?: string; playerVersion?: string; appVersion?: string }) {
    const session = await repo.createPairingSession({ code: pairingCode(), deviceId: input.deviceId, model: input.model, playerVersion: input.playerVersion, appVersion: input.appVersion, expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_SEC * 1000) });
    return { sessionId: session.id, code: session.code, expiresAt: session.expiresAt.toISOString() };
  },

  /** Player polls this after showing the code; returns the device credential once pairing completes. */
  async pollPairingSession(sessionId: string) {
    const session = await repo.findPairingBySession(sessionId);
    if (!session) throw new NotFoundError("Pairing session");
    if (session.status === "CONSUMED" && session.screenId) {
      const credential = await claimCredential(session.id, session.screenId, session.consumedAt);
      return { status: "PAIRED" as const, screenId: session.screenId, credential };
    }
    if (session.expiresAt < new Date()) return { status: "EXPIRED" as const };
    return { status: "PENDING" as const };
  },

  /**
   * User pairs a device. Runs in one transaction: lock the license row, count paired screens,
   * reject when at the limit, otherwise create the screen and consume the code.
   */
  async pair(actor: AuthUser, scope: TenantScope, body: z.infer<typeof pairBody>) {
    const companyId = requireCompanyId(scope);
    const screen = await withTransaction(async (tx) => {
      const session = await repo.findPairingByCode(body.code, tx);
      if (!session) throw new NotFoundError("Pairing code", "PAIRING_CODE_INVALID");
      if (session.status === "CONSUMED") throw new ConflictError("This device is already paired", "DEVICE_ALREADY_PAIRED");
      if (session.status === "EXPIRED" || session.expiresAt < new Date()) throw new GoneError("Pairing code has expired; restart pairing on the device", "PAIRING_CODE_EXPIRED");
      const existingDevice = await repo.findDeviceByDeviceId(session.deviceId, tx);
      if (existingDevice && existingDevice.screen.pairingStatus === "PAIRED") throw new ConflictError("This device is already paired", "DEVICE_ALREADY_PAIRED");

      const license = await licensesRepository.lockByCompany(companyId, tx);
      if (!license) throw new NotFoundError("License");
      if (license.state !== "ACTIVE") throw new ForbiddenError(`License is ${license.state.toLowerCase()}; pairing is blocked`, "LICENSE_INACTIVE");
      const paired = await licensesRepository.pairedCount(companyId, tx);
      if (paired >= license.screenLimit) throw new ConflictError(`Screen licence limit reached (${paired} of ${license.screenLimit})`, "LICENSE_LIMIT_REACHED", { paired, limit: license.screenLimit });

      if (body.groupId) {
        const ok = await tx.screenGroup.count({ where: { id: body.groupId, companyId } });
        if (!ok) throw new ValidationError("Group not found", undefined, "GROUP_NOT_FOUND");
      }
      if (existingDevice) await tx.screenDevice.delete({ where: { id: existingDevice.id } });

      const created = await repo.createScreen({
        companyId, name: body.name, location: body.location, orientation: body.orientation, tags: body.tags, status: "OFFLINE", pairingStatus: "PAIRED", syncState: "PENDING",
        device: { create: { deviceId: session.deviceId, model: session.model, playerVersion: session.playerVersion, appVersion: session.appVersion } },
        ...(body.groupId ? { groups: { create: { groupId: body.groupId } } } : {}),
      }, tx);
      await repo.consumePairing(session.id, created.id, companyId, tx);
      await logActivity({ companyId, actor, action: "screen.paired", resourceType: "screen", resourceId: created.id, summary: `${created.name} paired (${paired + 1} of ${license.screenLimit} licences used)` }, tx);
      return created;
    });
    return toScreenDtoAsync(screen);
  },

  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateScreenBody>) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing || existing.pairingStatus !== "PAIRED") throw new NotFoundError("Screen");
    // Orientation is in the manifest and the group decides which schedules apply.
    const manifestFields = (body.orientation !== undefined && body.orientation !== existing.orientation) || body.groupId !== undefined;
    const updated = await changeContent(existing.companyId, manifestFields ? { screenIds: [id] } : {}, async (tx) => {
      const s = await repo.update(id, { name: body.name, location: body.location, orientation: body.orientation, tags: body.tags }, tx);
      if (body.groupId !== undefined) {
        if (body.groupId) {
          const ok = await tx.screenGroup.count({ where: { id: body.groupId, companyId: existing.companyId } });
          if (!ok) throw new ValidationError("Group not found", undefined, "GROUP_NOT_FOUND");
        }
        await repo.setGroups(id, body.groupId ? [body.groupId] : [], tx);
      }
      return repo.findScoped(existing.companyId, s.id, tx);
    });
    await logActivity({ companyId: existing.companyId, actor, action: "screen.updated", resourceType: "screen", resourceId: id, summary: `${updated!.name} updated`, meta: { fields: Object.keys(body) } });
    return toScreenDtoAsync(updated!);
  },

  async unpair(actor: AuthUser, scope: TenantScope, id: string) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing || existing.pairingStatus !== "PAIRED") throw new NotFoundError("Screen");
    await withTransaction(async (tx) => {
      await repo.update(id, { pairingStatus: "REVOKED", deviceCredentialHash: null, status: "OFFLINE" }, tx);
      await tx.screenAssignment.deleteMany({ where: { screenId: id } });
      await tx.screenGroupMember.deleteMany({ where: { screenId: id } });
      await logActivity({ companyId: existing.companyId, actor, action: "screen.unpaired", resourceType: "screen", resourceId: id, summary: `${existing.name} unpaired; licence slot released` }, tx);
    });
    await clearPresence(id);
    emitToScreen(id, Events.remoteRefresh, { reason: "unpaired" });
    emitToCompany(existing.companyId, Events.presence, { screenId: id, status: "OFFLINE", at: new Date().toISOString() });
  },

  async command(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof remoteCommandBody>) {
    const existing = await repo.findScoped(scope.companyId, id);
    if (!existing || existing.pairingStatus !== "PAIRED") throw new NotFoundError("Screen");
    emitToScreen(id, body.command === "refresh" ? Events.remoteRefresh : Events.remoteRestart, { requestedAt: new Date().toISOString(), by: actor.id });
    await logActivity({ companyId: existing.companyId, actor, action: `screen.remote.${body.command}`, resourceType: "screen", resourceId: id, status: existing.status === "ONLINE" ? "SUCCESS" : "PENDING", summary: `${body.command === "refresh" ? "Refresh" : "Restart player"} requested on ${existing.name}${existing.status === "ONLINE" ? "" : " — awaiting reconnect"}` });
    return { dispatched: true, online: existing.status === "ONLINE" };
  },

  // ---- groups ----
  async listGroups(scope: TenantScope) {
    return (await repo.listGroups(requireCompanyId(scope))).map(toGroupDto);
  },
  async getGroup(scope: TenantScope, id: string) {
    const g = await repo.findGroup(requireCompanyId(scope), id);
    if (!g) throw new NotFoundError("Screen group");
    return toGroupDto(g);
  },
  async createGroup(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createGroupBody>) {
    const companyId = requireCompanyId(scope);
    await assertScreensBelong(companyId, body.screenIds);
    const g = await repo.createGroup({ companyId, name: body.name, description: body.description, members: { create: body.screenIds.map((screenId) => ({ screenId })) } });
    await logActivity({ companyId, actor, action: "group.created", resourceType: "screen_group", resourceId: g.id, summary: `Group "${g.name}" created with ${body.screenIds.length} screens` });
    return toGroupDto(g);
  },
  async updateGroup(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateGroupBody>) {
    const companyId = requireCompanyId(scope);
    const existing = await repo.findGroup(companyId, id);
    if (!existing) throw new NotFoundError("Screen group");
    if (body.screenIds) await assertScreensBelong(companyId, body.screenIds);
    // Members joining or leaving gain or lose the group's schedules.
    const g = await changeContent(companyId, body.screenIds ? { groupIds: [id] } : {}, async (tx) => {
      if (body.screenIds) await repo.setGroupMembers(id, body.screenIds, tx);
      return repo.updateGroup(id, { name: body.name, description: body.description }, tx);
    });
    await logActivity({ companyId, actor, action: "group.updated", resourceType: "screen_group", resourceId: id, summary: `Group "${g.name}" updated` });
    return toGroupDto(g);
  },
  async deleteGroup(actor: AuthUser, scope: TenantScope, id: string) {
    const companyId = requireCompanyId(scope);
    const existing = await repo.findGroup(companyId, id);
    if (!existing) throw new NotFoundError("Screen group");
    // Its schedules can never apply again, so they go too; former members lose them.
    await changeContent(companyId, { groupIds: [id] }, async (tx) => {
      await tx.schedule.deleteMany({ where: { companyId, targetKind: "GROUP", targetId: id } });
      await repo.deleteGroup(id, tx);
    });
    await logActivity({ companyId, actor, action: "group.deleted", resourceType: "screen_group", resourceId: id, summary: `Group "${existing.name}" deleted; ${existing.members.length} screens ungrouped` });
  },
};

async function assertScreensBelong(companyId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const count = await repo.countScreensInCompany(companyId, ids);
  if (count !== new Set(ids).size) throw new ValidationError("One or more screens do not belong to this company", undefined, "SCREEN_NOT_FOUND");
}

/**
 * Issues the device credential for a consumed session. The first poll always gets one; if that
 * response was lost, polls within CREDENTIAL_RECLAIM_SEC rotate it and return a new one, but only
 * until the device first authenticates, and only for the screen's latest pairing.
 */
async function claimCredential(sessionId: string, screenId: string, consumedAt: Date | null): Promise<string | null> {
  const credential = randomToken(48);
  const updated = await withTransaction(async (tx) => {
    const s = await tx.screen.findUnique({ where: { id: screenId }, select: { deviceCredentialHash: true, lastSeenAt: true, pairingStatus: true } });
    if (!s || s.pairingStatus !== "PAIRED") return false;
    const latest = await tx.pairingSession.findFirst({ where: { screenId, status: "CONSUMED" }, orderBy: { consumedAt: "desc" }, select: { id: true } });
    if (latest?.id !== sessionId) return false;
    if (s.deviceCredentialHash) {
      const inWindow = !!consumedAt && Date.now() - consumedAt.getTime() < CREDENTIAL_RECLAIM_SEC * 1000;
      if (!inWindow || s.lastSeenAt) return false;
    }
    // Compare-and-swap so two overlapping polls can't leave the device holding a stale credential.
    const { count } = await tx.screen.updateMany({ where: { id: screenId, deviceCredentialHash: s.deviceCredentialHash }, data: { deviceCredentialHash: sha256(credential) } });
    return count === 1;
  });
  return updated ? credential : null;
}
