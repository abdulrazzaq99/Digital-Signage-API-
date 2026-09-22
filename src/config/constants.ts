export const API_PREFIX = "/api/v1";
export const APP_VERSION = process.env.npm_package_version ?? "0.1.0";
export const PAIRING_CODE_TTL_SEC = 5 * 60;
/** A just-rotated refresh token is still accepted this long, returning the same new pair (parallel requests, tabs, retries). */
export const REFRESH_REUSE_GRACE_SEC = 20;
export const PRESENCE_TTL_SEC = 90;
export const PRESENCE_SWEEP_INTERVAL_MS = 30_000;
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const ALLOWED_MIME = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "video/mp4": "VIDEO",
  "application/pdf": "PDF",
} as const;
export const OFFER_VIEW_WINDOW_MIN = 30;
export const CANVAS_ACTIVATE_DELAY_MS = 5_000;
export const REQUEST_ID_HEADER = "x-request-id";
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const COMPANY_HEADER = "x-company-id";
