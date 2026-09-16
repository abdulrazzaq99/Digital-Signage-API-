import { mkdirSync, writeFileSync } from "node:fs";
import "../src/modules/index.js";
import { buildOpenApiDocument } from "../src/core/openapi/document.js";

mkdirSync("docs", { recursive: true });
writeFileSync("docs/openapi.json", JSON.stringify(buildOpenApiDocument(), null, 2));
console.warn("docs/openapi.json written");
// Importing the modules opens Prisma and Redis connections; exit explicitly.
process.exit(0);
