import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../../config/env.js";
import { PrismaClient } from "../../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter, log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

export async function checkDatabase(): Promise<"up" | "down"> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "up";
  } catch {
    return "down";
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
