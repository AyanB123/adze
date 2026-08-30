/**
 * @adze/sdk — the public embedding API for the Adze engine.
 *
 * ADR-0001's bet is that **the engine is the product and surfaces are
 * distribution**, and rule 4 of that decision is this package: a supported public
 * API so third parties can build a surface without our involvement or permission.
 * `examples/minimal-surface` is the proof — a complete surface, in one file, that
 * imports nothing but this package and runs offline.
 *
 * ```ts
 * import { createClient, scriptedProvider } from '@adze/sdk';
 *
 * const client = createClient({
 *   workspaceRoot: process.cwd(),
 *   model: { provider: 'scripted', model: 'offline' },
 *   provider: scriptedProvider({ script: [{ text: 'Hello.' }] }),
 *   onApprovalRequest: (request) => ({ requestId: request.requestId, decision: 'deny' }),
 * });
 *
 * const session = await client.createSession();
 * const stop = session.subscribe((event) => {
 *   if (event.type === 'text.delta') process.stdout.write(event.text);
 * });
 *
 * const result = await session.run({ prompt: 'Say hello.', budget: { maxSteps: 4 } });
 * //  -> { stopReason: 'end-turn', text: 'Hello.', usage, cost, cacheHitRate, steps }
 *
 * stop();
 * await client.dispose();
 * ```
 *
 * ## Four properties this package will not trade away
 *
 * **It renders nothing.** No colour, no terminal escapes, no display-intended
 * markdown, nothing written to a stream. Events are structured data and the consumer
 * renders them, which is what lets one engine serve a CLI, an editor extension, and
 * a daemon without becoming three products (ADR-0001 rule 1).
 *
 * **No core type is reachable.** Everything a consumer can name comes from this
 * package or from `@adze/protocol`. `@adze/sdk` is semver-strict from 1.0, and a
 * stability guarantee is worth nothing if a consumer can accidentally take a
 * dependency on an engine internal. `test/public-api.test.ts` asserts it.
 *
 * **Every tool call passes the permission gate.** There is no bypass and no
 * `trustEverything` flag — not as an option, not as an undocumented field. The
 * approval decision is yours to make through {@link ApprovalHandler}; whether one is
 * required is core's to decide (ADR-0007, architecture invariant 4).
 *
 * **Nothing leaves the machine.** No code path here makes a network call. Only the
 * provider you configure talks to the outside, and {@link scriptedProvider} does not
 * even do that.
 *
 * For an out-of-process engine — an editor sidecar that outlives its window — use
 * `@adze/protocol` directly: it carries the JSON-RPC framing this package
 * deliberately does not, because an in-process embedder should pay no serialization
 * cost for a transport it does not need.
 */

// --- Errors -----------------------------------------------------------------
export { AdzeConfigError, AdzeSessionError } from './errors.js';
// --- The client -------------------------------------------------------------
export { createClient } from './internal/client.js';
// --- The offline provider ---------------------------------------------------
export { scriptedProvider } from './internal/scripted.js';
// --- This package's own types ----------------------------------------------
export type {
  AdzeClient,
  AdzeClientOptions,
  AdzeSession,
  ApprovalHandler,
  CommandExecution,
  EventListener,
  ModelPrices,
  ModelProviderLike,
  PluginLike,
  RetrievalBackendLike,
  SandboxOptions,
  ScriptedProviderOptions,
  ScriptedStep,
  ScriptedToolCall,
  SessionOptions,
  SessionUsageReport,
  ToolLike,
  ToolLimits,
  TurnAttachment,
  TurnHandle,
  TurnInput,
  TurnResult,
  Unsubscribe,
  UsageReport,
} from './types.js';

/** This package's version, for a surface that reports what it embeds. */
export const SDK_VERSION = '0.0.1';

// ---------------------------------------------------------------------------
// The wire vocabulary
// ---------------------------------------------------------------------------
//
// Re-exported from `@adze/protocol` rather than redeclared, so a type is identical
// whether a surface embeds the engine in-process through this package or talks to it
// over JSON-RPC. Redeclaring would make the two drift, and a surface that switched
// transports would have to rewrite its renderer.

export type {
  AdzeEvent,
  AdzeEventType,
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
  EditAppliedEvent,
  EditProposedEvent,
  EditRefusedEvent,
  EngineCapabilities,
  ImageMediaType,
  JsonObject,
  JsonValue,
  MatchLocation,
  MatchStrategy,
  ModelSelection,
  PeerInfo,
  ProposedEdit,
  RefusedEdit,
  SandboxConfig,
  SandboxEnforcement,
  SandboxMode,
  StopReason,
  TextDeltaEvent,
  TodoItem,
  TodoStatus,
  TodoUpdatedEvent,
  ToolCall,
  ToolDeniedEvent,
  ToolFinishedEvent,
  ToolResult,
  ToolStartedEvent,
  Truncation,
  TurnBudget,
  TurnCompletedEvent,
  TurnStartedEvent,
  Usage,
  UsageUpdatedEvent,
  ValidationResult,
  ValidatorLevel,
  Warning,
  WarningCode,
} from '@adze/protocol';
export {
  ADZE_EVENT_TYPES,
  computeCacheHitRate,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  isTerminalEvent,
  PROTOCOL_VERSION,
  refusesRatherThanPrompts,
  SUPPORTED_PROTOCOL_VERSIONS,
  sandboxEnforcement,
} from '@adze/protocol';
