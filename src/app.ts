import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { API_PREFIX } from "./config/constants.js";
import { env } from "./config/env.js";
import { errorHandler } from "./core/errors/errorHandler.js";
import { httpLogger } from "./core/middleware/logger.js";
import { notFound } from "./core/middleware/notFound.js";
import { requestId } from "./core/middleware/requestId.js";
import { openapiRouter } from "./core/openapi/routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { apiRouter } from "./modules/index.js";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(requestId);
  app.use(httpLogger);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true, exposedHeaders: ["x-request-id"] }));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.use(healthRouter);
  app.use(openapiRouter);
  app.use(API_PREFIX, apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
