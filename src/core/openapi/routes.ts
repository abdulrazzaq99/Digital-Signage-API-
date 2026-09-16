import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiDocument } from "./document.js";

export const openapiRouter = Router();

openapiRouter.get("/openapi.json", (_req, res) => {
  res.json(buildOpenApiDocument());
});

openapiRouter.use("/docs", swaggerUi.serve);
openapiRouter.get("/docs", (req, res, next) => {
  swaggerUi.setup(buildOpenApiDocument(), { customSiteTitle: "DSP API Docs" })(req, res, next);
});
