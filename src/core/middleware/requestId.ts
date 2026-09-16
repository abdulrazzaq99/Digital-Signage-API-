import type { RequestHandler } from "express";
import { nanoid } from "nanoid";
import { REQUEST_ID_HEADER } from "../../config/constants.js";

declare module "express-serve-static-core" {
  interface Request {
    id: string;
  }
}

/** Reuses an incoming X-Request-Id or generates one, and echoes it on the response. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(REQUEST_ID_HEADER);
  req.id = incoming && incoming.length <= 128 ? incoming : nanoid(16);
  res.setHeader(REQUEST_ID_HEADER, req.id);
  next();
};
