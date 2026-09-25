import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deepLink, email, endAfterStart, hexColour, id, int, list, password, passwordUsesEmail, phone, tags, text, timezone, url } from "./fields.js";

const ok = (s: z.ZodType, v: unknown) => s.safeParse(v);

describe("field building blocks", () => {
  it("text trims, rejects blanks and enforces the maximum", () => {
    expect(text(5).parse("  hi  ")).toBe("hi");
    expect(ok(text(5), "   ").success).toBe(false);
    expect(ok(text(5), "toolong").success).toBe(false);
    expect(ok(text(10, 3), "ab").success).toBe(false);
  });

  it("email lower-cases and trims, and rejects malformed addresses", () => {
    expect(email().parse("  Sarah@AcmeCorp.COM ")).toBe("sarah@acmecorp.com");
    for (const bad of ["sarah", "sarah@", "@acme.com", "a b@c.com", `${"a".repeat(250)}@x.com`]) expect(ok(email(), bad).success).toBe(false);
  });

  it("id accepts cuids only", () => {
    expect(ok(id(), "cmu418w8h000d01lfllymhxg0").success).toBe(true);
    for (const bad of ["", "1", "abc", "cmu418w8h000d01lfllymhxg0; DROP", "x".repeat(500)]) expect(ok(id(), bad).success).toBe(false);
  });

  it("phone strips formatting and accepts international or local numbers", () => {
    expect(phone().parse("+44 20 7946-0000")).toBe("+442079460000");
    expect(phone().parse("(020) 7946 0000")).toBe("02079460000");
    for (const bad of ["12345", "+0 123 456 789", "call me", "+44 20 7946 0000 ext 5"]) expect(ok(phone(), bad).success).toBe(false);
  });

  it("url only allows http(s) with a real host", () => {
    expect(ok(url(), "https://acmecorp.com/about").success).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://x.com", "https://localhost", "acmecorp.com"]) expect(ok(url(), bad).success).toBe(false);
  });

  it("deepLink allows app paths and https URLs", () => {
    expect(ok(deepLink(), "/offers/abc?tab=1").success).toBe(true);
    expect(ok(deepLink(), "https://acme.com/x").success).toBe(true);
    expect(ok(deepLink(), "javascript:alert(1)").success).toBe(false);
  });

  it("hexColour normalises and rejects non-colours", () => {
    expect(hexColour().parse("#ABC")).toBe("#aabbcc");
    expect(hexColour().parse("#1A73E8")).toBe("#1a73e8");
    for (const bad of ["red", "#12345", "1a73e8", "#ggg"]) expect(ok(hexColour(), bad).success).toBe(false);
  });

  it("timezone accepts IANA names only", () => {
    expect(ok(timezone(), "Europe/London").success).toBe(true);
    expect(ok(timezone(), "UTC").success).toBe(true);
    expect(ok(timezone(), "London").success).toBe(false);
  });

  it("int bounds whole numbers", () => {
    expect(ok(int(1, 10), 5).success).toBe(true);
    for (const bad of [0, 11, 2.5, "5", Number.NaN]) expect(ok(int(1, 10), bad).success).toBe(false);
  });

  it("list caps length and removes duplicates; tags normalise", () => {
    expect(list(z.string(), 3).parse(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(ok(list(z.string(), 2), ["a", "b", "c"]).success).toBe(false);
    expect(tags().parse([" Lobby ", "lobby", "VIP"])).toEqual(["lobby", "vip"]);
  });

  it("password requires a letter and a number and rejects common ones", () => {
    expect(ok(password(), "Signage-Blue-42").success).toBe(true);
    for (const bad of ["short1", "allletters", "12345678", "admin1234", "Password123", "x".repeat(129) + "1"]) expect(ok(password(), bad).success).toBe(false);
    expect(passwordUsesEmail("sarah2026!", "sarah@acme.com")).toBe(true);
    expect(passwordUsesEmail("Blue-Harbor-7", "sarah@acme.com")).toBe(false);
  });

  it("endAfterStart flags an end before the start on the end field", () => {
    const s = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date().optional() }).superRefine(endAfterStart("startsAt", "endsAt"));
    expect(s.safeParse({ startsAt: "2026-10-02", endsAt: "2026-10-03" }).success).toBe(true);
    const r = s.safeParse({ startsAt: "2026-10-03", endsAt: "2026-10-02" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["endsAt"]);
  });
});
