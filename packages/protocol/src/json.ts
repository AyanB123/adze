/**
 * JSON value schemas.
 *
 * JSON-RPC params, tool arguments, and tool results are JSON by construction, and
 * the protocol has to be able to say so without reaching for `unknown` (which
 * pushes the check to every consumer) or `any` (which is banned repository-wide,
 * and for good reason: an `any` here would silently accept a `Date` or a class
 * instance that then fails to serialize somewhere far away).
 */

import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Recursive, so it needs `z.lazy`. `z.toJSONSchema` renders this as a
 * self-referencing `$ref`, which is exactly right.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
