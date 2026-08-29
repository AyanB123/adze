/**
 * JSON Schema generation.
 *
 * Exists so that consumers outside TypeScript can validate Adze messages. A
 * protocol that is only checkable from TypeScript is a TypeScript API with extra
 * steps, and ADR-0001 promises third parties can build a surface without our
 * involvement — in whatever language they like.
 *
 * **What the generated schemas do and do not cover.** They describe *shape*:
 * fields, types, enums, required-ness, and the closed-object rule. They do not
 * describe cross-field invariants, because JSON Schema cannot express them
 * usefully and a published artifact that silently omits a rule is worse than one
 * that never claimed to have it. Those invariants live in named predicates
 * beside the schemas instead — `toolResultTruncationIsConsistent`,
 * `computeCacheHitRate` — and this is the reason the Zod schemas avoid
 * `.refine()`: a Zod schema stricter than its published JSON Schema would make
 * the artifact a lie about what the wire accepts.
 */

import { z } from 'zod';
import { AdzeEventSchema } from './events.js';
import type { JsonValueSchema } from './json.js';
import {
  JsonRpcErrorResponseSchema,
  JsonRpcMessageSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
} from './jsonrpc.js';
import { METHOD, METHOD_SCHEMAS } from './messages.js';
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  AttachmentSchema,
  SandboxConfigSchema,
  ToolCallSchema,
  ToolResultSchema,
  UsageSchema,
  WarningSchema,
} from './primitives.js';

/**
 * A generated JSON Schema document. `JsonValue`-shaped because that is what it
 * is: the generator's output is JSON, and typing it as such means it can be
 * written to disk or returned over the wire without a cast.
 */
export type JsonSchemaDocument = Record<string, z.infer<typeof JsonValueSchema>>;

/** Draft 2020-12: what `ajv` defaults to and what tooling in 2026 expects. */
const TARGET = 'draft-2020-12' as const;

/**
 * Convert one schema.
 *
 * `io: 'input'` on purpose. The output type of a schema with defaults marks the
 * defaulted fields as required, which is true of parsed data but wrong as a
 * description of what a *sender* must transmit — and validating a sender is what
 * these documents are for.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchemaDocument {
  return z.toJSONSchema(schema, { target: TARGET, io: 'input' }) as JsonSchemaDocument;
}

/**
 * Named top-level schemas, in the bundle.
 *
 * Method params and results are added below from `METHOD_SCHEMAS` rather than
 * listed by hand, so a new method cannot be added without its schemas appearing
 * here too.
 */
const NAMED_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  // Framing
  JsonRpcRequest: JsonRpcRequestSchema,
  JsonRpcNotification: JsonRpcNotificationSchema,
  JsonRpcSuccess: JsonRpcSuccessSchema,
  JsonRpcErrorResponse: JsonRpcErrorResponseSchema,
  JsonRpcMessage: JsonRpcMessageSchema,
  // Vocabulary
  Attachment: AttachmentSchema,
  ToolCall: ToolCallSchema,
  ToolResult: ToolResultSchema,
  SandboxConfig: SandboxConfigSchema,
  ApprovalRequest: ApprovalRequestSchema,
  ApprovalResponse: ApprovalResponseSchema,
  Usage: UsageSchema,
  Warning: WarningSchema,
  // The event stream
  AdzeEvent: AdzeEventSchema,
};

function methodSchemaName(method: string, part: 'Params' | 'Result'): string {
  const pascal = method
    .split('.')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
  return `${pascal}${part}`;
}

/**
 * Every published schema, keyed by name.
 *
 * Each document is standalone rather than `$ref`-linked into a shared `$defs`.
 * Standalone documents are larger and repeat definitions, and they are worth it:
 * a consumer can hand one file to a validator without resolving references
 * across files, which is the difference between "usable from Python in five
 * minutes" and "usable after you write a resolver".
 */
export function protocolJsonSchemas(): Record<string, JsonSchemaDocument> {
  const out: Record<string, JsonSchemaDocument> = {};
  for (const [name, schema] of Object.entries(NAMED_SCHEMAS)) {
    out[name] = toJsonSchema(schema);
  }
  for (const method of Object.values(METHOD)) {
    const entry = METHOD_SCHEMAS[method];
    out[methodSchemaName(method, 'Params')] = toJsonSchema(entry.params);
    // `event` is a notification: no result schema exists, and inventing an empty
    // one would imply a reply is permitted.
    if (entry.result !== null) {
      out[methodSchemaName(method, 'Result')] = toJsonSchema(entry.result);
    }
  }
  return out;
}

/** Names in the bundle, sorted. Used by the generator and by its drift test. */
export function protocolJsonSchemaNames(): string[] {
  return Object.keys(protocolJsonSchemas()).sort();
}
