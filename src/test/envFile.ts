import { existsSync } from "node:fs";

/** `.env.test` when a developer has one; otherwise the committed defaults that match docker-compose.test.yml. */
export const testEnvFile = existsSync(".env.test") ? ".env.test" : ".env.test.example";
