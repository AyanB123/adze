/**
 * JSON-RPC 2.0 framing.
 *
 * The transport is stdio or WebSocket; the framing is the same either way, which
 * is what lets the CLI run the engine in-process and the IDE run it as a sidecar
 * without either being a special case (docs/architecture/README.md §3).
 *
 * Both directions send requests. The surface calls `session.create`; the engine
 * calls `approval.request` back. So these schemas are deliberately
 * direction-agnostic.
 */

import { z } from 'zod';
import { JsonValueSchema } from './json.js';

export const JSONRPC_VERSION = '2.0';

/**
 * Per JSON-RPC 2.0 §4 an id is a string or a number. `null` is permitted by the
 * spec but explicitly discouraged, so it is not accepted on a request. It is
 * accepted on an error *response*, where the spec requires it when the request
 * could not be parsed well enough to recover an id.
 */
export const RequestIdSchema = z.union([z.string().min(1), z.number().int()]);
export type RequestId = z.infer<typeof RequestIdSchema>;

export const JsonRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  method: z.string().min(1),
  params: JsonValueSchema.optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/** A request with no id: fire and forget, no response permitted. */
export const JsonRpcNotificationSchema = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string().min(1),
  params: JsonValueSchema.optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

export const JsonRpcSuccessSchema = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  result: JsonValueSchema,
});
export type JsonRpcSuccess = z.infer<typeof JsonRpcSuccessSchema>;

export const JsonRpcErrorObjectSchema = z.strictObject({
  code: z.int(),
  message: z.string().min(1),
  data: JsonValueSchema.optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcErrorResponseSchema = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: z.union([RequestIdSchema, z.null()]),
  error: JsonRpcErrorObjectSchema,
});
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export const JsonRpcResponseSchema = z.union([JsonRpcSuccessSchema, JsonRpcErrorResponseSchema]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/**
 * Anything that can arrive on the wire.
 *
 * Order matters. A notification is structurally a request without `id`, so the
 * request variants must be tried first or every request would validate as a
 * notification and its `id` would be dropped — which strips the caller's ability
 * to correlate a response. This union is not `discriminatedUnion` because the
 * discriminator is the *presence* of a key rather than its value.
 */
export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcNotificationSchema,
]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

/**
 * Error codes.
 *
 * -32768..-32000 is reserved by the spec; -32099..-32000 within it is the
 * implementation-defined server error range, which is where the Adze-specific
 * codes live. Each one exists because a caller does something different in
 * response to it — a single generic code would push everyone back to string
 * matching on `message`, which is not a contract.
 */
export const JsonRpcErrorCode = {
  // --- JSON-RPC 2.0 standard ---
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // --- Adze, implementation-defined range ---
  /** Version negotiation found no shared version. Update one side. */
  ProtocolVersionUnsupported: -32000,
  /** The session id is unknown or already closed. */
  SessionNotFound: -32001,
  /** A turn is already running on this session; cancel it or wait. */
  TurnAlreadyActive: -32002,
  /** The turn id is unknown, or already finished. */
  TurnNotFound: -32003,
  /**
   * The permission gate refused. Distinct from `ApprovalRefused` because the
   * remedy differs: this one means the sandbox mode forbids the action outright.
   */
  PermissionDenied: -32004,
  /**
   * The action needed approval and the approval policy is `never`.
   *
   * ADR-0007: `never` refuses rather than escalating. A policy that silently
   * granted more than it says would make the whole model untrustworthy, so this
   * is a distinct code and not a variant of `PermissionDenied`.
   */
  ApprovalRefused: -32005,
  /** A declared budget (steps, tokens, wall clock, spend) was exhausted. */
  BudgetExhausted: -32006,
  /** The turn was cancelled by the caller. */
  Cancelled: -32007,
  /** The configured provider cannot do native tool calling (ADR-0004). */
  ProviderDegraded: -32008,
} as const;

export type JsonRpcErrorCodeValue = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

export function jsonRpcRequest(
  id: RequestId,
  method: string,
  params?: z.infer<typeof JsonValueSchema>,
): JsonRpcRequest {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

export function jsonRpcNotification(
  method: string,
  params?: z.infer<typeof JsonValueSchema>,
): JsonRpcNotification {
  return {
    jsonrpc: JSONRPC_VERSION,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

export function jsonRpcSuccess(
  id: RequestId,
  result: z.infer<typeof JsonValueSchema>,
): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function jsonRpcError(
  id: RequestId | null,
  code: number,
  message: string,
  data?: z.infer<typeof JsonValueSchema>,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function isJsonRpcRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'method' in m && 'id' in m;
}

export function isJsonRpcNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return 'method' in m && !('id' in m);
}

export function isJsonRpcSuccess(m: JsonRpcMessage): m is JsonRpcSuccess {
  return 'result' in m;
}

export function isJsonRpcErrorResponse(m: JsonRpcMessage): m is JsonRpcErrorResponse {
  return 'error' in m;
}
