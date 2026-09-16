import type { RequestHandler } from "express";
import { NotFoundError } from "../errors/AppError.js";

export const notFound: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl}`, "ROUTE_NOT_FOUND"));
};
