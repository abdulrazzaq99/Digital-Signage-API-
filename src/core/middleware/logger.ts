import pino from "pino";
import { pinoHttp } from "pino-http";
import { env, isProd, isTest } from "../../config/env.js";

/** Secret-bearing keys, redacted at the top level and up to three levels deep in any logged object. */
const SECRET_KEYS = ["password", "passwordHash", "currentPassword", "newPassword", "token", "tokenHash", "accessToken", "refreshToken", "credential", "credentialHash", "secret", "apiKey", "authorization", "cookie"];
const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]);

/** s***@acmecorp.com: keeps the first character and the domain so logs stay useful without the full address. */
export const maskEmail = (value: string) => value.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2");

/** Masks emails in a URL (search boxes put them in the query string), including percent-encoded @. */
export const maskUrl = (url: string | undefined) => (url ? maskEmail(url.replace(/%40/gi, "@")) : url);

export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,
  ...(isProd ? {} : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }),
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { id?: string }).id ?? "unknown",
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
  autoLogging: { ignore: (req) => req.url === "/health" },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: maskUrl(req.url) }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
