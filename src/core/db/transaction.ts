import { prisma } from "./prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";

export type Tx = Prisma.TransactionClient;

/** Runs `fn` inside a serializable-enough interactive transaction with a sane timeout. */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { maxWait: 5000, timeout: 15000 });
}
