export const API_PREFIX = "/api/v1";
export const APP_VERSION = process.env.npm_package_version ?? "0.1.0";
export const PAIRING_CODE_TTL_SEC = 5 * 60;
/** After pairing, a player that lost the poll response can re-claim (rotate) its credential this long, until it first uses it. */
export const CREDENTIAL_RECLAIM_SEC = 10 * 60;
/** A just-rotated refresh token is still accepted this long, returning the same new pair (parallel requests, tabs, retries). */
export const REFRESH_REUSE_GRACE_SEC = 20;
export const PASSWORD_RESET_TTL_SEC = 60 * 60;
export const INVITE_TTL_SEC = 7 * 24 * 60 * 60;
export const PRESENCE_TTL_SEC = 90;
export const PRESENCE_SWEEP_INTERVAL_MS = 30_000;
/** Uploads still UPLOADING this long after their last URL was issued are deleted by the worker. */
export const ABANDONED_UPLOAD_SEC = 24 * 60 * 60;
export const MEDIA_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** How often the worker marks lapsed licences EXPIRED and past-endsAt offers EXPIRED. */
export const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
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
