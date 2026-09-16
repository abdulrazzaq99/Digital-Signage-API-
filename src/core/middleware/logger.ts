import pino from "pino";
import { pinoHttp } from "pino-http";
import { env, isProd, isTest } from "../../config/env.js";

export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,
  ...(isProd ? {} : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }),
  redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.passwordHash", "*.token"],
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { id?: string }).id ?? "unknown",
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
  autoLogging: { ignore: (req) => req.url === "/health" },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
