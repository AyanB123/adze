/**
 * @adze/protocol — the versioned wire contract between the Adze engine and every
 * surface.
 *
 * This package depends on nothing but `zod`. A contract with dependencies is not a
 * contract: if `protocol` imported the applier, then every surface would
 * transitively depend on a specific applier implementation and the boundary would
 * be decorative.
 *
 * The rule this package exists to enforce (ADR-0001, rule 2): **surfaces reach the
 * engine only through these messages.** When the CLI can do something the
 * extension cannot, the protocol is missing a message — add the message. Never add
 * a private back channel. That is what prevents the CLI, the extension, and the
 * IDE from becoming three products with three bug surfaces, which is the observed
 * failure mode that killed every single-surface project in this category.
 *
 * ```ts
 * import {
 *   METHOD,
 *   PROTOCOL_VERSION,
 *   SUPPORTED_PROTOCOL_VERSIONS,
 *   negotiateProtocolVersion,
 *   jsonRpcRequest,
 *   parseParams,
 * } from '@adze/protocol';
 *
 * // A surface's first message.
 * const hello = jsonRpcRequest(1, METHOD.Initialize, {
 *   protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
 *   client: { name: 'adze-cli', version: '0.0.1', platform: process.platform },
 * });
 *
 * // The engine's side.
 * const parsed = parseParams(METHOD.Initialize, hello.params);
 * if (parsed.ok) {
 *   const agreed = negotiateProtocolVersion(parsed.value.protocolVersions);
 *   //  -> { ok: true, version: '0.1' } | { ok: false, message: '...' }
 * }
 * ```
 *
 * Design rationale: docs/architecture/README.md and
 * docs/architecture/adr/0001-engine-first-architecture.md.
 */

export type {
  AdzeEvent,
  AdzeEventType,
  EditAppliedEvent,
  EditProposedEvent,
  EditRefusedEvent,
  StopReason,
  TextDeltaEvent,
  TodoUpdatedEvent,
  ToolDeniedEvent,
  ToolFinishedEvent,
  ToolStartedEvent,
  TurnCompletedEvent,
  TurnStartedEvent,
  UsageUpdatedEvent,
} from './events.js';
// --- Events -----------------------------------------------------------------
export {
  ADZE_EVENT_TYPES,
  AdzeEventSchema,
  EditAppliedEventSchema,
  EditProposedEventSchema,
  EditRefusedEventSchema,
  isTerminalEvent,
  StopReasonSchema,
  TextDeltaEventSchema,
  TodoUpdatedEventSchema,
  ToolDeniedEventSchema,
  ToolFinishedEventSchema,
  ToolStartedEventSchema,
  TurnCompletedEventSchema,
  TurnStartedEventSchema,
  UsageUpdatedEventSchema,
} from './events.js';
export type { JsonObject, JsonValue } from './json.js';
// --- JSON -------------------------------------------------------------------
export { JsonObjectSchema, JsonValueSchema } from './json.js';
export type {
  JsonRpcErrorCodeValue,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  RequestId,
} from './jsonrpc.js';
// --- JSON-RPC framing -------------------------------------------------------
export {
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  JsonRpcErrorObjectSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcMessageSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  JsonRpcSuccessSchema,
  jsonRpcError,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcSuccess,
  RequestIdSchema,
} from './jsonrpc.js';
export type {
  EngineCapabilities,
  EventParams,
  InitializeParams,
  InitializeResult,
  MethodName,
  ParseOutcome,
  PeerInfo,
  SessionCloseParams,
  SessionCloseResult,
  SessionCreateParams,
  SessionCreateResult,
  TurnCancelParams,
  TurnCancelResult,
  TurnSubmitParams,
  TurnSubmitResult,
} from './messages.js';
// --- Messages ---------------------------------------------------------------
export {
  CLIENT_METHODS,
  ENGINE_METHODS,
  EngineCapabilitiesSchema,
  EventParamsSchema,
  formatIssues,
  InitializeParamsSchema,
  InitializeResultSchema,
  isMethodName,
  METHOD,
  METHOD_SCHEMAS,
  PeerInfoSchema,
  parseParams,
  SessionCloseParamsSchema,
  SessionCloseResultSchema,
  SessionCreateParamsSchema,
  SessionCreateResultSchema,
  TurnCancelParamsSchema,
  TurnCancelResultSchema,
  TurnSubmitParamsSchema,
  TurnSubmitResultSchema,
} from './messages.js';
export type {
  AppliedEdit,
  ApplyFailureReason,
  ApplyTelemetry,
  ApplyTier,
  ApprovalDecision,
  ApprovalKind,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  Attachment,
  CommandRule,
  ContentBlock,
  Cost,
  EditBlock,
  ImageMediaType,
  MatchLocation,
  MatchStrategy,
  ModelSelection,
  ProposedEdit,
  RefusedEdit,
  SandboxConfig,
  SandboxEnforcement,
  SandboxMode,
  TodoItem,
  TodoStatus,
  ToolCall,
  ToolResult,
  Truncation,
  TurnBudget,
  Usage,
  ValidationResult,
  ValidatorLevel,
  Warning,
  WarningCode,
} from './primitives.js';
// --- Shared vocabulary ------------------------------------------------------
export {
  AppliedEditSchema,
  ApplyFailureReasonSchema,
  ApplyTelemetrySchema,
  ApplyTierSchema,
  ApprovalDecisionSchema,
  ApprovalKindSchema,
  ApprovalPolicySchema,
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  AttachmentSchema,
  CommandRuleSchema,
  ContentBlockSchema,
  CostSchema,
  computeCacheHitRate,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  EditBlockSchema,
  ImageAttachmentSchema,
  ImageMediaTypeSchema,
  MatchLocationSchema,
  MatchStrategySchema,
  ModelSelectionSchema,
  makeUsage,
  ProposedEditSchema,
  RefusedEditSchema,
  refusesRatherThanPrompts,
  SandboxConfigSchema,
  SandboxModeSchema,
  sandboxEnforcement,
  TextAttachmentSchema,
  TodoItemSchema,
  TodoStatusSchema,
  ToolCallSchema,
  ToolResultSchema,
  TruncationSchema,
  TurnBudgetSchema,
  toolResultTruncationIsConsistent,
  UsageSchema,
  ValidationResultSchema,
  ValidatorLevelSchema,
  WarningCodeSchema,
  WarningSchema,
} from './primitives.js';
export type { JsonSchemaDocument } from './schema.js';
// --- JSON Schema generation -------------------------------------------------
export { protocolJsonSchemaNames, protocolJsonSchemas, toJsonSchema } from './schema.js';
export type { ParsedVersion, VersionNegotiation } from './version.js';
// --- Version negotiation ----------------------------------------------------
export {
  negotiateProtocolVersion,
  PROTOCOL_VERSION,
  ProtocolVersionSchema,
  parseProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './version.js';
