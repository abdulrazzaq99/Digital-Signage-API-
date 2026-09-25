import { describe, expect, it } from "vitest";
import { maskEmail, maskUrl } from "./logger.js";

describe("log masking", () => {
  it("masks emails but keeps the first letter and domain", () => {
    expect(maskEmail("user sarah.mitchell@acmecorp.com logged in")).toBe("user s***@acmecorp.com logged in");
  });
  it("masks emails in URLs, including percent-encoded ones", () => {
    expect(maskUrl("/api/v1/users?search=sarah%40acmecorp.com&page=1")).toBe("/api/v1/users?search=s***@acmecorp.com&page=1");
    expect(maskUrl("/api/v1/screens?page=2")).toBe("/api/v1/screens?page=2");
  });
});
