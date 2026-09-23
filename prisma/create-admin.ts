/**
 * Creates the first Super Admin on an empty production database (the demo seed ships known passwords).
 * ADMIN_EMAIL is required; ADMIN_NAME defaults to "Super Admin"; without ADMIN_PASSWORD a random one is
 * generated and printed once. Refuses to touch an existing user.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "../src/generated/prisma/client.js";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Set ADMIN_EMAIL to the admin's email address");
  const name = process.env.ADMIN_NAME?.trim() || "Super Admin";
  const given = process.env.ADMIN_PASSWORD;
  if (given !== undefined && given.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  const password = given ?? randomBytes(12).toString("base64url");

  if (await prisma.user.findUnique({ where: { email } })) throw new Error(`A user with email ${email} already exists`);

  await prisma.user.create({
    data: { email, name, passwordHash: await argon2.hash(password), platformRole: "SUPER_ADMIN", title: "Super Admin" },
  });

  console.log(`Super Admin created: ${email}`);
  if (given === undefined) console.log(`Password (shown once, change it after first login): ${password}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
