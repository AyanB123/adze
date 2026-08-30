/**
 * The public type surface of `@adze/sdk`.
 *
 * Every type a consumer can name lives here, and this file imports **only**
 * `@adze/protocol`. That is the whole mechanism behind the stability tier: a
 * consumer cannot accidentally depend on a `@adze/core` internal, because no core
 * type appears in any position they can reach. Anything that touches core lives
 * under `src/internal/`, and `test/public-api.test.ts` asserts that boundary
 * rather than trusting it (ADR-0001 rule 4, architecture README §4).
 *
 * ## Seam handles, and why they look under-specified
 *
 * {@link ModelProviderLike}, {@link ToolLike}, {@link PluginLike}, and
 * {@link RetrievalBackendLike} each declare only the fields the SDK itself reads.
 * They are deliberately *not* full descriptions of the interface an implementor
 * satisfies, because those interfaces are written in core-internal vocabulary
 * (`ConversationMessage`, `ToolSpec`, `ModelStreamChunk`, `PriceSheet`, `Grant`)
 * for which `@adze/protocol` has no equivalent. Naming them here would re-export a
 * core internal through the very boundary this package exists to draw.
 *
 * The consequence is honest and stated rather than hidden: a value you pass for
 * one of these is checked at construction by
 * {@link AdzeConfigError}-raising runtime validation, not by the compiler. See
 * README.md "Types that belong in the protocol" for what would have to move into
 * `@adze/protocol` to make these compile-time checked.
 */

import type {
  AdzeEvent,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  CommandRule,
  Cost,
  EngineCapabilities,
  JsonObject,
  ModelSelection,
  PeerInfo,
  SandboxConfig,
  SandboxMode,
  StopReason,
  TurnBudget,
  Usage,
  Warning,
} from '@adze/protocol';

// ---------------------------------------------------------------------------
// Seam handles
// ---------------------------------------------------------------------------

/**
 * A model gateway.
 *
 * Obtain one from `@adze/providers` for real models, or from
 * {@link scriptedProvider} for an offline run with no key and no cost.
 *
 * Structurally an implementation must also supply `stream()` and `priceFor()`;
 * both are validated at {@link createClient} time. They are absent from this
 * declaration on purpose — see the file header.
 */
export interface ModelProviderLike {
  /** Appears in trajectory logs and in warning text. */
  readonly name: string;
  /**
   * False means `degraded`: the engine runs turns **without tools** and reports a
   * `degraded-provider` warning. Adze ships no JSON-in-a-string fallback, because
   * that transport carries a measured ~7% invalid-JSON rejection rate (ADR-0004).
   */
  readonly nativeToolCalling: boolean;
}

/**
 * A tool beyond the built-ins — an MCP-backed tool, or one from a plugin.
 *
 * A tool added here is **not** exempt from anything. Its `execute` still requires
 * a grant that only the permission gate can mint, so every call it makes is
 * authorized under the session's sandbox mode and approval policy (ADR-0007).
 */
export interface ToolLike {
  readonly name: string;
  /** Written for a model choosing between tools, not for a UI. */
  readonly description: string;
  /** JSON Schema for the provider's native tool-calling payload. */
  readonly parameters: JsonObject;
}

/**
 * A lifecycle hook, as produced by `@adze/plugin-sdk`.
 *
 * Hooks may deny a tool call or rewrite its arguments, which is how a team encodes
 * its own policy without forking. They may **not** inject UI: UI extension is
 * per-surface (ADR-0001 rule 3).
 */
export interface PluginLike {
  readonly id: string;
}

/**
 * Ranked, structured search, as produced by `@adze/retrieval`.
 *
 * Without one, `glob`, `grep`, and `symbols` report themselves unavailable rather
 * than returning empty results, and {@link AdzeClient.capabilities} reports
 * `retrieval: false`.
 */
export interface RetrievalBackendLike {
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * How a command a tool asks to run is actually executed.
 *
 * `subprocess` spawns one process per call with a credential-scrubbed
 * environment. `disabled` refuses every command, which is what an example, a
 * test, or a review-only surface wants.
 *
 * This is an execution *mechanism*, orthogonal to {@link SandboxOptions.mode},
 * which is policy. Neither one is a containment claim: there is no OS-level
 * sandbox on any platform today, so an approved command runs unconfined
 * (ADR-0007). The engine says so in {@link AdzeClient.warnings}.
 */
export type CommandExecution = 'subprocess' | 'disabled';

export interface SandboxOptions {
  /** Defaults to `workspace-write`. */
  readonly mode?: SandboxMode;
  /** Absolute paths writable under `workspace-write`. Empty means the workspace. */
  readonly writableRoots?: readonly string[];
  /** Hosts reachable when the mode would otherwise deny network. */
  readonly allowedNetworkHosts?: readonly string[];
  /** Per-prefix overrides, so `pnpm test` can be allowed without widening the mode. */
  readonly commandRules?: readonly CommandRule[];
}

/** Ceilings the engine applies to every tool result, uniformly. */
export interface ToolLimits {
  readonly maxResultBytes?: number;
  readonly timeoutMs?: number;
}

/**
 * Answer an approval request.
 *
 * The SDK never prompts, never reads stdin, and never writes to stdout: deciding
 * is the surface's job, and a library that prompted would make itself unusable
 * from a GUI, a daemon, or CI. Returning a rejected promise is treated as a
 * denial, because an approval channel that throws has not produced consent.
 *
 * Not consulted at all when the policy in force is `never` — that policy refuses
 * rather than escalating, so there is nothing to ask (ADR-0007).
 */
export type ApprovalHandler = (
  request: ApprovalRequest,
) => ApprovalResponse | Promise<ApprovalResponse>;

/** Receives every event the engine emits. Never throws into the engine's loop. */
export type EventListener = (event: AdzeEvent) => void;

/** Stops a subscription. Idempotent. */
export type Unsubscribe = () => void;

export interface AdzeClientOptions {
  /**
   * Absolute path to the workspace.
   *
   * Passed explicitly rather than read from `process.cwd()`, because an embedder
   * may be a daemon or an editor sidecar started from somewhere unrelated.
   */
  readonly workspaceRoot: string;
  readonly provider: ModelProviderLike;
  /**
   * Required, and with no default.
   *
   * A default would have to be either a guess or the literal string `unset`, and
   * both end up in trajectory logs and benchmark reports as if they were a real
   * selection. Pin a dated snapshot wherever the provider offers one; an alias
   * here is a reproducibility hole (docs/benchmarks/strategy.md).
   */
  readonly model: ModelSelection;
  /** Identifies your surface in trajectory logs. Defaults to `@adze/sdk`. */
  readonly client?: PeerInfo;
  readonly sandbox?: SandboxOptions;
  /** Defaults to `on-request`: prompt only for what the sandbox would block. */
  readonly approvals?: ApprovalPolicy;
  readonly onApprovalRequest?: ApprovalHandler;
  /** Applied to every turn that does not carry its own. */
  readonly budget?: TurnBudget;
  /** Extra instructions, e.g. assembled from `AGENTS.md`. */
  readonly instructions?: string;
  readonly tools?: readonly ToolLike[];
  readonly plugins?: readonly PluginLike[];
  readonly retrieval?: RetrievalBackendLike;
  readonly limits?: ToolLimits;
  /** Defaults to `subprocess`. */
  readonly commandExecution?: CommandExecution;
  /**
   * Where a listener's own exception goes.
   *
   * A throwing listener must not stall or crash the engine's loop, so the SDK
   * catches it. It cannot log — the SDK renders nothing — so without this the
   * exception is swallowed. Provide it if you want to see them.
   */
  readonly onListenerError?: (error: unknown, event: AdzeEvent) => void;
}

export interface SessionOptions {
  /** Overrides the client's model for this session. */
  readonly model?: ModelSelection;
  readonly sandbox?: SandboxOptions;
  readonly approvals?: ApprovalPolicy;
  readonly instructions?: string;
}

export interface TurnInput {
  readonly prompt: string;
  /** Text or image. Images are a first-class path, not an extension (ADR-0004). */
  readonly attachments?: readonly TurnAttachment[];
  /** Overrides the client's default budget for this turn. */
  readonly budget?: TurnBudget;
  /** Per-turn override. Absent means the session's settings apply unchanged. */
  readonly sandbox?: SandboxOptions;
  readonly approvals?: ApprovalPolicy;
}

/** Re-exported protocol shape, named so it appears in this package's docs. */
export type TurnAttachment =
  | { readonly type: 'text'; readonly name?: string; readonly text: string }
  | {
      readonly type: 'image';
      readonly name?: string;
      readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      /** Base64, no `data:` prefix. */
      readonly data: string;
    };

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Token and money accounting.
 *
 * The three token counts do not overlap, so prompt size is
 * `inputTokens + cachedInputTokens`. `cost` is `undefined` when the provider has
 * no prices for the model — a real answer, and reported as one rather than as
 * zero, because a wrong cost figure is worse than no cost figure.
 */
export interface UsageReport {
  readonly usage: Usage;
  readonly cost: Cost | undefined;
  /** Fraction of prompt tokens served from cache, in [0, 1]. */
  readonly cacheHitRate: number;
}

export interface TurnResult extends UsageReport {
  readonly turnId: string;
  readonly stopReason: StopReason;
  /** Concatenated assistant text. */
  readonly text: string;
  /** Model round-trips. */
  readonly steps: number;
  /** Set when `stopReason` is `error` or `refused`. */
  readonly message?: string;
}

export interface SessionUsageReport extends UsageReport {
  readonly turns: number;
}

/** A turn in flight. */
export interface TurnHandle {
  readonly turnId: string;
  /**
   * Ask the engine to stop.
   *
   * False when the turn had already finished — a normal race, not an error. The
   * engine completes the history with synthetic results for calls that never ran,
   * so the next turn is still valid and the trajectory is still replayable.
   */
  cancel(): boolean;
  /** Resolves when the turn stops, for any reason. A refusal is a result. */
  result(): Promise<TurnResult>;
}

// ---------------------------------------------------------------------------
// Client and session
// ---------------------------------------------------------------------------

export interface AdzeSession {
  readonly id: string;
  /** What is actually in force, which can differ from what was requested. */
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly model: ModelSelection;
  /** Limitations this session's configuration carries. Render these. */
  readonly warnings: readonly Warning[];
  /** Events for this session only. */
  subscribe(listener: EventListener): Unsubscribe;
  /** Start a turn and return immediately. Progress arrives as events. */
  submit(input: TurnInput): Promise<TurnHandle>;
  /** {@link submit} then await. The one-turn convenience. */
  run(input: TurnInput): Promise<TurnResult>;
  usage(): SessionUsageReport;
  /** Cancels any turn in flight and releases the session. Idempotent. */
  close(): Promise<SessionUsageReport>;
}

export interface AdzeClient {
  /** The agreed protocol version. Both sides speak exactly this. */
  readonly protocolVersion: string;
  /** What this engine build can do. Every `false` is a roadmap item, not a bug. */
  readonly capabilities: EngineCapabilities;
  readonly engine: PeerInfo;
  /**
   * Startup limitations — no OS sandbox, a degraded provider.
   *
   * Surface these *before* a user approves anything. A user about to approve a
   * command needs to know there is no containment first.
   */
  readonly warnings: readonly Warning[];
  readonly model: ModelSelection;
  /** Events from every session on this client. */
  subscribe(listener: EventListener): Unsubscribe;
  createSession(options?: SessionOptions): Promise<AdzeSession>;
  /** Closes every session, cancels every turn, drops every listener. Idempotent. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The offline provider
// ---------------------------------------------------------------------------

/** Per-million-token prices for one model. */
export interface ModelPrices {
  /** ISO 4217, three letters. */
  readonly currency: string;
  readonly inputPerMTok: number;
  /** Cache *reads*. Typically a fraction of the input rate. */
  readonly cachedInputPerMTok: number;
  readonly outputPerMTok: number;
}

export interface ScriptedToolCall {
  readonly name: string;
  readonly arguments: JsonObject;
  /** Defaults to a deterministic `call_<step>_<index>`. */
  readonly callId?: string;
}

/** One model round-trip, scripted. */
export interface ScriptedStep {
  /** Emitted as a single delta. Use `textDeltas` to exercise chunked streaming. */
  readonly text?: string;
  readonly textDeltas?: readonly string[];
  readonly toolCalls?: readonly ScriptedToolCall[];
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  /** Delay before the first chunk. Exercises cancellation and wall-clock budgets. */
  readonly delayMs?: number;
  /** Throw instead of streaming, to exercise the error path. */
  readonly fails?: string;
}

export interface ScriptedProviderOptions {
  /** Played in order. A script that runs out yields a plain stop. */
  readonly script: readonly ScriptedStep[];
  /** Defaults to `scripted`. */
  readonly name?: string;
  /** Omit and `cost` is reported as unknown rather than as zero. */
  readonly prices?: ModelPrices;
  /** Defaults to true. Set false to exercise the `degraded-provider` path. */
  readonly nativeToolCalling?: boolean;
}
