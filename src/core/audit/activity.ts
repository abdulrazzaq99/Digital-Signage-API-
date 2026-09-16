import type { AuthUser } from "../auth/scope.js";
import { prisma } from "../db/prisma.js";
import type { Tx } from "../db/transaction.js";
import type { ActivityStatus } from "../../generated/prisma/enums.js";

export interface ActivityInput {
  companyId?: string | null;
  actor?: AuthUser | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  summary: string;
  status?: ActivityStatus;
  meta?: Record<string, unknown>;
}

/** Writes one audit entry. Pass `tx` to make it part of a transaction. */
export async function logActivity(input: ActivityInput, tx?: Tx): Promise<void> {
  const client = tx ?? prisma;
  await client.activityLog.create({
    data: {
      companyId: input.companyId ?? null,
      actorId: input.actor?.id ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      status: input.status ?? "SUCCESS",
      summary: input.summary,
      meta: input.meta ? JSON.parse(JSON.stringify(input.meta)) : undefined,
    },
  });
}
