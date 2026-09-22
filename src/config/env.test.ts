import { describe, expect, it } from "vitest";
import { envSchema } from "./env.js";

describe("env boolean flags", () => {
  it("parses S3_FORCE_PATH_STYLE=false as false", () => {
    const flag = envSchema.shape.S3_FORCE_PATH_STYLE;
    expect(flag.parse("false")).toBe(false);
    expect(flag.parse("0")).toBe(false);
    expect(flag.parse("true")).toBe(true);
    expect(flag.parse(undefined)).toBe(true);
    expect(() => flag.parse("perhaps")).toThrow();
  });
});
