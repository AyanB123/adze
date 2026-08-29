/**
 * @adze/core — the headless Adze engine.
 *
 * The engine is the product; surfaces are distribution. This package is the turn
 * machine, the tool registry, the permission gate, and the context assembler, and it
 * renders nothing: it emits structured `@adze/protocol` events and imports no surface
 * package (ADR-0001).
 *
 * ```ts
 * import {
 *   Engine,
 *   EventLog,
 *   NodeSubprocessBroker,
 *   ScriptedProvider,
 * } from '@adze/core';
 *
 * const log = new EventLog();
 * const engine = new Engine({
 *   provider: new ScriptedProvider({
 *     script: [
 *       { toolCalls: [{ name: 'bash', arguments: { command: 'pnpm test' } }] },
 *       { text: 'Tests pass.' },
 *     ],
 *   }),
 *   broker: new NodeSubprocessBroker(),
 *   sink: log.sink,
 * });
 *
 * engine.initialize({
 *   protocolVersions: ['0.1'],
 *   client: { name: 'my-surface', version: '1.0.0', platform: process.platform },
 * });
 *
 * const { sessionId } = await engine.sessionCreate({
 *   workspaceRoot: process.cwd(),
 *   model: { provider: 'scripted', model: 'test' },
 * });
 * const { turnId } = await engine.turnSubmit({
 *   sessionId,
 *   prompt: 'Run the tests.',
 *   attachments: [],
 *   budget: { maxSteps: 8 },
 * });
 * const outcome = await engine.awaitTurn(turnId);
 * //  -> { stopReason: 'end-turn', usage, steps, text }
 * ```
 *
 * **What is real, and what is an interface waiting for its package.** The loop,
 * budgets, gate, epochs, registry, and the `bash` / `read` / `write` / `edit` /
 * `todo` / `task` tools all work. `ModelProvider` (`@adze/providers`),
 * `SearchBackend` (`@adze/retrieval`), and OS-level containment inside
 * `SandboxBroker` (`@adze/sandbox`) are seams with no implementation here — the
 * bundled broker runs stateless subprocesses and reports `gate-only` enforcement,
 * which is what it has. See `docs/roadmap.md`.
 *
 * Design rationale: docs/architecture/adr/0003-agent-loop.md,
 * docs/architecture/adr/0004-tool-surface.md,
 * docs/architecture/adr/0007-sandbox-and-permissions.md.
 */

// --- Sandbox broker seam ----------------------------------------------------
export type {
  CommandCompleted,
  CommandOutcome,
  CommandRequest,
  CommandSpawnFailed,
  Containment,
  NodeSubprocessBrokerOptions,
  SandboxBroker,
} from './broker.js';
export { NodeSubprocessBroker, NullBroker, scrubEnvironment } from './broker.js';
// --- Budgets ----------------------------------------------------------------
export type { BudgetExhausted, BudgetKind, Clock } from './budget.js';
export { BudgetTracker, systemClock } from './budget.js';
// --- Context assembly -------------------------------------------------------
export type {
  AssembledContext,
  BaselineInputs,
  CacheEpoch,
  EpochRollReason,
} from './context.js';
export {
  ContextAssembler,
  epochKey,
  fingerprintOf,
  renderBaseline,
  serializeHistory,
} from './context.js';
// --- Cost -------------------------------------------------------------------
export type { PriceSheet } from './cost.js';
export { addUsage, computeCost, totalTokens, ZERO_USAGE } from './cost.js';
// --- Tool dispatch ----------------------------------------------------------
export type { DispatchDeps, DispatchOutcome, DispatchRequest } from './dispatch.js';
export { dispatchToolCall } from './dispatch.js';
// --- Engine -----------------------------------------------------------------
export type { EngineOptions } from './engine.js';
export { Engine } from './engine.js';
// --- Events -----------------------------------------------------------------
export type { EventSink } from './events.js';
export { EventLog, TurnEmitter } from './events.js';
// --- Filesystem -------------------------------------------------------------
export type { ContainmentCheck, EngineFileSystem, FileStat } from './fs.js';
export { isWithin, MemoryFileSystem, nodeFileSystem, resolveWithinRoots } from './fs.js';
// --- Hooks ------------------------------------------------------------------
export type {
  Disposable,
  Hooks,
  RegisteredHook,
  ToolPostContext,
  ToolPostOutcome,
  ToolPreContext,
  ToolPreOutcome,
  TurnEndContext,
  TurnStartContext,
  TurnStartOutcome,
} from './hooks.js';
export { HookBus } from './hooks.js';
// --- Ids --------------------------------------------------------------------
export type { IdFactory } from './ids.js';
export { randomIdFactory, sequentialIdFactory } from './ids.js';
// --- Permission gate --------------------------------------------------------
export type {
  ApprovalRequester,
  Authorization,
  AuthorizationRequest,
  Grant,
  GrantExecOptions,
  PermissionGateOptions,
} from './permissions.js';
export { matchCommandRule, PermissionError, PermissionGate } from './permissions.js';
// --- Model gateway seam -----------------------------------------------------
export type {
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelStreamChunk,
  RecordedRequest,
  ScriptedProviderOptions,
  ScriptedStep,
  ScriptedStepContext,
  ScriptedStepFn,
  ScriptedToolCall,
} from './provider.js';
export { FailingProvider, ScriptedProvider } from './provider.js';
// --- Tool registry ----------------------------------------------------------
export type { NarrowOutcome, ToolSpec } from './registry.js';
export { defineTool, ToolRegistry } from './registry.js';
// --- Retrieval seam ---------------------------------------------------------
export type {
  GlobOutcome,
  GlobQuery,
  SearchBackend,
  SearchHit,
  SearchOutcome,
  SearchQuery,
  SymbolHit,
  SymbolKind,
  SymbolOutcome,
  SymbolQuery,
} from './retrieval.js';
// --- Sessions ---------------------------------------------------------------
export type { ActiveTurn, SessionInit, SessionSnapshot, SessionStore } from './session.js';
export { InMemorySessionStore, Session } from './session.js';
// --- Structured test feedback -----------------------------------------------
export type { CommandRenderOptions, CommandStructure } from './test-feedback.js';
export {
  extractFailureLines,
  renderCommandResult,
  renderSpawnFailure,
  summarizeCommand,
} from './test-feedback.js';
// --- Built-in tools ---------------------------------------------------------
export type {
  BashToolOptions,
  BuiltinToolOptions,
  EditToolOptions,
  ReadToolOptions,
} from './tools/index.js';
export {
  builtinTools,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createSymbolsTool,
  createTaskTool,
  createTodoTool,
  createWriteTool,
} from './tools/index.js';
// --- Truncation -------------------------------------------------------------
export type { TruncateOptions, TruncateResult, TruncationBias } from './truncate.js';
export { ContinuationStore, estimateTokens, truncateContent, truncateText } from './truncate.js';
// --- Turn machine -----------------------------------------------------------
export type { TurnDeps, TurnOutcome, TurnRequest } from './turn.js';
export { runTurn, TurnConfigurationError } from './turn.js';
// --- Engine vocabulary ------------------------------------------------------
export type {
  AssistantMessage,
  ContinuationResolver,
  ConversationMessage,
  Effect,
  EffectContext,
  MessageOrigin,
  PreparedCall,
  PrepareOutcome,
  RegisteredTool,
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  SystemMessage,
  ToolContext,
  ToolDefinition,
  ToolEmission,
  ToolExecution,
  ToolLimits,
  ToolMessage,
  UserMessage,
} from './types.js';
