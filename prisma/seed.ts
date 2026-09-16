/* Demo seed. Populated fully in the schema task; this placeholder keeps the build and migrate step valid. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });

async function main(): Promise<void> {
  const companies = await prisma.company.count();
  console.warn(`seed: ${companies} companies present`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
