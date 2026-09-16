/**
 * Typed application errors. Services throw these; the error middleware maps
 * them to HTTP responses. Anything not an AppError becomes a 500.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(requestId?: string) {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}), ...(requestId ? { requestId } : {}) } };
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown, code = "VALIDATION_ERROR") {
    super(400, code, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required", code = "UNAUTHORIZED") {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource", code = "FORBIDDEN") {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource", code = "NOT_FOUND") {
    super(404, code, `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "CONFLICT", details?: unknown) {
    super(409, code, message, details);
  }
}

export class GoneError extends AppError {
  constructor(message: string, code = "GONE") {
    super(410, code, message);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSec: number) {
    super(429, "RATE_LIMITED", "Too many requests, please try again later", { retryAfterSec });
  }
}
