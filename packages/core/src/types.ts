/**
 * Engine-side vocabulary.
 *
 * Everything on the wire lives in `@adze/protocol` and is imported from there
 * rather than redeclared. What is here is the part of the engine that never
 * crosses a surface boundary: the shape of the linear history, what a tool is,
 * and the seams to service packages that do not exist yet.
 *
 * Two rules shape this file.
 *
 * **The engine renders nothing** (ADR-0001). No type here carries a
 * pre-rendered string, a terminal escape, or display-intended markdown. The one
 * place prose appears is a message addressed to the *model* — a refusal reason,
 * a tool-argument validation error — which is a functional part of the retry
 * loop rather than presentation.
 *
 * **The trajectory is the prompt** (ADR-0003). {@link ConversationMessage} is
 * plain JSON, appended in order, and never mutated. There is no side channel: if
 * information reached the model it is in this array, which is what makes a run
 * replayable and directly usable as fine-tuning or RL data.
 */

import type {
  AppliedEdit,
  ContentBlock,
  JsonObject,
  ProposedEdit,
  RefusedEdit,
  TodoItem,
  ToolCall,
} from '@adze/protocol';
import type { z } from 'zod';
import type { Grant } from './permissions.js';
import type { SearchBackend } from './retrieval.js';

// ---------------------------------------------------------------------------
// Linear history
// ---------------------------------------------------------------------------

/**
 * Where a message came from.
 *
 * Recorded so that "no hidden state, no side channels" is *checkable* rather than
 * merely asserted: every message in a trajectory declares its provenance, so an
 * auditor can tell model output from tool output from a plugin's injected
 * context without guessing from the role. Providers ignore it.
 */
export type MessageOrigin = 'user' | 'model' | 'tool' | 'hook' | 'engine';

export interface SystemMessage {
  readonly role: 'system';
  readonly origin: MessageOrigin;
  readonly content: readonly ContentBlock[];
}

export interface UserMessage {
  readonly role: 'user';
  readonly origin: MessageOrigin;
  readonly content: readonly ContentBlock[];
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly origin: MessageOrigin;
  readonly content: readonly ContentBlock[];
  /**
   * Native tool calls, exactly as the provider parsed them. Empty when the model
   * only spoke.
   *
   * There is deliberately no JSON-in-a-string variant anywhere in the engine:
   * that transport carries a measured ~7% invalid-JSON rejection tax on
   * open-weight models, concentrated in exactly the cheap models that matter on
   * cost (ADR-0004).
   */
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolMessage {
  readonly role: 'tool';
  readonly origin: MessageOrigin;
  /** Correlates with the {@link AssistantMessage} tool call of the same id. */
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly content: readonly ContentBlock[];
}

export type ConversationMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * A side effect a tool intends to perform, declared *before* it runs.
 *
 * This is what makes the permission gate enforceable rather than advisory. A
 * tool cannot ask for a capability at execution time, because by then the only
 * thing it holds is a {@link Grant} the gate already minted for a specific
 * effect list.
 */
export type Effect =
  | { readonly kind: 'command'; readonly command: readonly string[]; readonly cwd: string }
  | { readonly kind: 'file-read'; readonly path: string }
  | { readonly kind: 'file-write'; readonly path: string }
  | { readonly kind: 'network'; readonly host: string };

/** Read-only session facts a tool needs in order to declare its effects. */
export interface EffectContext {
  readonly workspaceRoot: string;
}

/** What a tool may emit besides its result. Tools never construct events. */
export type ToolEmission =
  | { readonly kind: 'edit.proposed'; readonly proposal: ProposedEdit }
  | { readonly kind: 'edit.applied'; readonly applied: AppliedEdit }
  | { readonly kind: 'edit.refused'; readonly refused: RefusedEdit }
  | { readonly kind: 'todo.updated'; readonly items: readonly TodoItem[] };

/**
 * A tool's own output, before the engine truncates it.
 *
 * Tools return everything they produced and the *engine* decides what fits
 * (ADR-0004). Leaving truncation to each tool would make the context budget a
 * per-tool convention, and one tool forgetting is a context-window
 * denial-of-service.
 */
export interface ToolExecution {
  readonly ok: boolean;
  readonly content: readonly ContentBlock[];
  /** Failure detail when `ok` is false. Never a stack trace. */
  readonly error?: string;
  readonly emissions?: readonly ToolEmission[];
  /**
   * Full text the engine should retain so the model can ask for the rest.
   *
   * Set this when `content` is a window onto something larger. The engine
   * registers it and returns a continuation token; without it, truncation is
   * data loss and the engine says so instead of handing out a token it cannot
   * honour.
   */
  readonly continuable?: { readonly label: string; readonly text: string };
}

/** Ceilings the engine applies to every tool, uniformly. */
export interface ToolLimits {
  /** Hard cap on returned bytes per tool result. */
  readonly maxResultBytes: number;
  /** Wall-clock ceiling for a single tool call. */
  readonly timeoutMs: number;
}

/** Everything a tool is allowed to touch. */
export interface ToolContext {
  readonly workspaceRoot: string;
  /**
   * The gate's authorization, and the only route to a subprocess or the
   * filesystem. Minted by {@link PermissionGate.authorize} and unconstructible
   * anywhere else, so "every tool call passes the permission gate" is a
   * compile-time property rather than a review item.
   */
  readonly grant: Grant;
  readonly signal: AbortSignal;
  readonly limits: ToolLimits;
  /**
   * Ranked, structured search. `undefined` when no backend is configured, in
   * which case the search tools report themselves unavailable rather than
   * silently returning nothing.
   */
  readonly search: SearchBackend | undefined;
  /** Current plan state, for the `todo` tool. */
  readonly todos: readonly TodoItem[];
  /** Delegation, for the `task` tool. `undefined` outside a turn. */
  readonly runSubagent: SubagentRunner | undefined;
  /** Resolves a continuation token issued by an earlier result. */
  readonly continuations: ContinuationResolver;
}

export interface ContinuationResolver {
  resolve(token: string): { readonly label: string; readonly text: string } | undefined;
}

/**
 * A tool, before type erasure.
 *
 * `schema` is Zod, and it is the only way arguments enter a tool: see
 * {@link defineTool}, which makes `execute` unreachable until `schema` has
 * accepted the model's arguments.
 */
export interface ToolDefinition<A> {
  readonly name: string;
  /** Written for a model choosing between tools. Not for a UI. */
  readonly description: string;
  readonly schema: z.ZodType<A>;
  /** Declared from arguments alone, before anything runs. */
  effects(args: A, ctx: EffectContext): readonly Effect[];
  execute(args: A, ctx: ToolContext): Promise<ToolExecution>;
}

/**
 * A validated tool call, ready to authorize and run.
 *
 * The two functions close over the *parsed* arguments, which is why neither
 * takes them. That is the point: there is no way to reach `execute` with
 * arguments the schema has not accepted, and no way to reach it without a
 * {@link Grant}.
 */
export interface PreparedCall {
  effects(ctx: EffectContext): readonly Effect[];
  execute(ctx: ToolContext): Promise<ToolExecution>;
}

export type PrepareOutcome =
  | { readonly ok: true; readonly call: PreparedCall }
  | { readonly ok: false; readonly issues: readonly string[] };

/** A tool with its argument type erased, as stored in the registry. */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the provider's native tool-calling payload. */
  readonly parameters: JsonObject;
  prepare(args: JsonObject): PrepareOutcome;
}

// ---------------------------------------------------------------------------
// Subagents — the delegation primitive, not a planner/executor split
// ---------------------------------------------------------------------------

/**
 * Runs a nested turn with a narrowed tool allowlist.
 *
 * ADR-0003 keeps tree search, planner/executor splits, and reflection layers out
 * of the core loop. A subagent is the sanctioned escape hatch: it is the same
 * boring loop, with fewer tools and its own budget, and it cannot widen the
 * parent's allowlist.
 */
export interface SubagentRequest {
  readonly prompt: string;
  /** Must be a subset of the parent's tools. A wider list is an error. */
  readonly tools: readonly string[];
  readonly maxSteps?: number;
}

export interface SubagentResult {
  readonly ok: boolean;
  /** The subagent's final assistant text, which is all the parent sees. */
  readonly text: string;
  readonly steps: number;
  readonly stopReason: string;
  readonly error?: string;
}

export type SubagentRunner = (request: SubagentRequest) => Promise<SubagentResult>;
