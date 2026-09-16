import { execSync } from "node:child_process";
import { config } from "dotenv";

/** Runs once before the test suite: load .env.test and apply migrations to the test database. */
export default function globalSetup(): void {
  config({ path: ".env.test", override: true });
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env } });
}
