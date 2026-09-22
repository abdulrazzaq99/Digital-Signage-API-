import { z } from "zod";

/**
 * A true/false query parameter. Parsed from the literal text, so `?flag=false` is false (unlike
 * `z.coerce.boolean()`), and documented as a boolean so generated clients send `true`/`false`.
 */
export function queryFlag(): z.ZodOptional<z.ZodCodec<z.ZodString, z.ZodBoolean>>;
export function queryFlag(defaultValue: boolean): z.ZodDefault<z.ZodCodec<z.ZodString, z.ZodBoolean>>;
export function queryFlag(defaultValue?: boolean) {
  const flag = z.stringbool();
  return defaultValue === undefined ? flag.optional().openapi({ type: "boolean" }) : flag.default(defaultValue).openapi({ type: "boolean", default: defaultValue });
}
