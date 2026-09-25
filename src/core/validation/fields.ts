/**
 * Field building blocks for request schemas. Every string is trimmed and length-bounded, every
 * number bounded, every list capped. Module schemas use these instead of bare `z.string()`, so
 * limits live in one place and the web dashboards can mirror them.
 */
import { z } from "zod";
import { COMMON_PASSWORDS } from "./common-passwords.js";

/** Trimmed text between `min` and `max` characters. `min` defaults to 1, so blank strings fail. */
export const text = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min, min === 1 ? "Required" : `Must be at least ${min} characters`)
    .max(max, `Must be at most ${max} characters`);

/**
 * Optional free text for update bodies and optional fields: blank becomes `undefined` (field left
 * alone) on create; use `clearableText` where the client needs to clear a stored value.
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .transform((v) => v || undefined)
    .optional();

/** Text that can be cleared: blank or null becomes `null`. */
export const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .nullable()
    .transform((v) => v || null)
    .optional();

/** Lower-cased, trimmed email address (RFC 5321 length limit). */
export const email = () => z.string().trim().toLowerCase().max(254, "Must be at most 254 characters").pipe(z.email("Enter a valid email address"));

/** Database id (cuid). */
export const id = () => z.string().regex(/^c[a-z0-9]{20,31}$/, "Invalid id");

/** Kebab-case identifier for built-in presets and template field keys. */
export const slug = (max = 60) => z.string().trim().max(max).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Use lowercase letters, numbers, - or _");

/**
 * Phone number. Spaces, dashes, dots and brackets are stripped; the result must be an international
 * number (+ and 7-15 digits) or a local one starting with 0.
 */
export const phone = () =>
  z
    .string()
    .trim()
    .max(40)
    .transform((v) => v.replace(/[\s\-().]/g, ""))
    .pipe(z.string().regex(/^(\+[1-9]\d{6,14}|0\d{6,14})$/, "Enter a valid phone number, e.g. +44 20 7946 0000"));

/** http(s) URL only, so `javascript:` and `data:` links can never be stored. */
export const url = (max = 2048) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => {
      try {
        const u = new URL(v);
        return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
      } catch {
        return false;
      }
    }, "Enter a valid http(s) URL, e.g. https://example.com");

/** In-app path or http(s) URL for notification deep links. */
export const deepLink = () =>
  z
    .string()
    .trim()
    .max(500)
    .refine((v) => /^\/[\w\-./?=&%#]*$/.test(v) || url().safeParse(v).success, "Enter an app path like /offers/123 or an https URL");

/** #rrggbb colour (short #rgb is expanded). */
export const hexColour = () =>
  z
    .string()
    .trim()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Enter a colour like #1a73e8")
    .transform((v) => (v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v).toLowerCase());

const ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC", "Etc/UTC"]);
/** IANA time zone name, e.g. Europe/London. */
export const timezone = () => z.string().trim().refine((v) => ZONES.has(v), "Choose a valid time zone, e.g. Europe/London");

/** Whole number between `min` and `max`. */
export const int = (min: number, max: number) => z.number({ error: "Must be a number" }).int("Must be a whole number").min(min, `Must be at least ${min}`).max(max, `Must be at most ${max}`);

/** List capped at `max` items, with duplicates removed. */
export const list = <T extends z.ZodType>(item: T, max: number, min = 0) =>
  z
    .array(item)
    .min(min, min === 1 ? "Choose at least one" : `Choose at least ${min}`)
    .max(max, `At most ${max} items`)
    .transform((items) => [...new Set(items)] as z.output<T>[]);

/** Tag list: each tag trimmed, 1-40 characters, lower-cased, de-duplicated, at most 20. */
export const tags = () => list(z.string().trim().toLowerCase().min(1).max(40, "Tags must be at most 40 characters"), 20);

/** ISO date-time string, parsed to a Date. */
export const dateTime = () => z.coerce.date({ error: "Enter a valid date and time" });

/** Rejects a date that is already more than a minute in the past (allows for clock skew). */
export const notInPast = (d: Date) => d.getTime() >= Date.now() - 60_000;

/** Refinement: `end` must be after `start` when both are present. Attach with `.superRefine(endAfterStart("startsAt", "endsAt"))`. */
export function endAfterStart<K1 extends string, K2 extends string>(startKey: K1, endKey: K2) {
  return (v: Partial<Record<K1 | K2, Date | null | undefined>>, ctx: z.RefinementCtx) => {
    const start = v[startKey];
    const end = v[endKey];
    if (start && end && end.getTime() <= start.getTime()) ctx.addIssue({ code: "custom", path: [endKey], message: "Must be after the start" });
  };
}

/**
 * New password: 8-128 characters with a letter and a number, not one of the most common passwords.
 * Services also call `assertPasswordAllowed` to reject passwords built from the user's email.
 */
export const password = () =>
  z
    .string()
    .min(8, "Must be at least 8 characters")
    .max(128, "Must be at most 128 characters")
    .regex(/[A-Za-z]/, "Must include a letter")
    .regex(/\d/, "Must include a number")
    .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), "This password is too common. Choose something less predictable");

/** An existing password being checked (login, current password): bounded so huge strings never reach argon2. */
export const passwordInput = () => z.string().min(1, "Required").max(128, "Must be at most 128 characters");

/** True when the password contains the email's name part (e.g. "sarah" in sarah@acme.com). */
export function passwordUsesEmail(pw: string, userEmail: string): boolean {
  const name = userEmail.split("@")[0]?.toLowerCase() ?? "";
  return name.length >= 3 && pw.toLowerCase().includes(name);
}

/** Opaque token from a link or earlier response: bounded, no whitespace. */
export const token = (max = 512) => z.string().trim().min(1, "Required").max(max).regex(/^\S+$/, "Invalid token");
