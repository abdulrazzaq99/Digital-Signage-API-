import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { API_PREFIX, APP_VERSION } from "../../config/constants.js";
import { registry } from "./registry.js";

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: { title: "Digital Signage Platform API", version: APP_VERSION, description: "Shared Platform API for the web dashboards, mobile app, and Android player." },
    servers: [{ url: API_PREFIX }],
  });
}
