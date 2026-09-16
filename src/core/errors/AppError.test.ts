import { describe, expect, it } from "vitest";
import { AppError, ConflictError, ForbiddenError, NotFoundError, RateLimitError, UnauthorizedError, ValidationError } from "./AppError.js";

describe("AppError hierarchy", () => {
  it.each([
    [new ValidationError(), 400, "VALIDATION_ERROR"],
    [new UnauthorizedError(), 401, "UNAUTHORIZED"],
    [new ForbiddenError(), 403, "FORBIDDEN"],
    [new NotFoundError("Screen"), 404, "NOT_FOUND"],
    [new ConflictError("dup"), 409, "CONFLICT"],
    [new RateLimitError(30), 429, "RATE_LIMITED"],
  ])("%s maps to status %i and code %s", (err, status, code) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });

  it("serialises to the error envelope with request id", () => {
    const err = new NotFoundError("Screen");
    expect(err.toJSON("req-1")).toEqual({ error: { code: "NOT_FOUND", message: "Screen not found", requestId: "req-1" } });
  });

  it("allows custom codes and details", () => {
    const err = new ConflictError("Limit reached", "LICENSE_LIMIT_REACHED", { limit: 5 });
    expect(err.toJSON()).toEqual({ error: { code: "LICENSE_LIMIT_REACHED", message: "Limit reached", details: { limit: 5 } } });
  });
});
