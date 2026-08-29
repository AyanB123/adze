/**
 * The engine.
 *
 * A headless facade over the turn machine, speaking `@adze/protocol` types and
 * nothing else. It imports no surface package and emits no display-intended output:
 * everything a surface needs arrives as a structured {@link AdzeEvent} on the sink
 * (ADR-0001, architecture invariants 1 and 2).
 *
 * There is deliberately no JSON-RPC here. Framing, stdio, and WebSocket belong to
 * `@adze/sdk` and the surfaces; the engine is a set of typed methods so that
 * embedding it in-process — which the CLI does, for startup latency — costs no
 * serialization at all.
 *
 * ## What is real and what is a seam
 *
 * Real: the turn machine, budgets, the permission gate, the epoch assembler, the
 * tool registry, `bash`/`read`/`write`/`edit`/`todo`/`task`, and stateless
 * subprocess execution.
 *
 * Seams with no implementation in this package, by design:
 *
 * - **Providers.** {@link ModelProvider} is an interface; `@adze/providers` will
 *   implement it. `core` ships only {@link ScriptedProvider}, which makes the loop
 *   testable with zero network and zero cost.
 * - **Retrieval.** {@link SearchBackend} is an interface; `@adze/retrieval` will
 *   implement it. Without one, `glob`, `grep`, and `symbols` report themselves
 *   unavailable rather than returning empty results.
 * - **OS containment.** {@link SandboxBroker} is the seam `@adze/sandbox` will fill.
 *   The bundled broker runs stateless subprocesses and reports `gate-only`
 *   enforcement, because that is what it has.
 *
 * See `docs/roadmap.md` for when each lands.
 */

import type {
  AdzeEvent,
  ApprovalPolicy,
  EngineCapabilities,
  InitializeParams,
  InitializeResult,
  ModelSelection,
  PeerInfo,
  SandboxConfig,
  SessionCloseParams,
  SessionCloseResult,
  SessionCreateParams,
  SessionCreateResult,
  TurnCancelParams,
  TurnCancelResult,
  TurnSubmitParams,
  TurnSubmitResult,
  Warning,
} from '@adze/protocol';
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  negotiateProtocolVersion,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@adze/protocol';
import type { SandboxBroker } from './broker.js';
import { ContextAssembler } from './context.js';
import { type EventSink, TurnEmitter } from './events.js';
import { type EngineFileSystem, nodeFileSystem } from './fs.js';
import { type Disposable, HookBus, type RegisteredHook } from './hooks.js';
import { type IdFactory, randomIdFactory } from './ids.js';
import { type ApprovalRequester, PermissionGate } from './permissions.js';
import type { ModelProvider } from './provider.js';
import { ToolRegistry } from './registry.js';
import type { SearchBackend } from './retrieval.js';
import { InMemorySessionStore, Session, type SessionStore } from './session.js';
import { builtinTools } from './tools/index.js';
import { ContinuationStore } from './truncate.js';
import { runTurn, type TurnOutcome } from './turn.js';
import type {
  RegisteredTool,
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  ToolLimits,
} from './types.js';

const DEFAULT_LIMITS: ToolLimits = {
  maxResultBytes: 32 * 1024,
  timeoutMs: 120_000,
};

/** Steps a subagent gets when it does not ask for a number. */
const DEFAULT_SUBAGENT_STEPS = 12;

export interface EngineOptions {
  readonly provider: ModelProvider;
  readonly broker: SandboxBroker;
  readonly sink: EventSink;
  /** Defaults to `@adze/core`'s own identity. */
  readonly engineInfo?: PeerInfo;
  readonly fs?: EngineFileSystem;
  readonly store?: SessionStore;
  readonly search?: SearchBackend;
  readonly requestApproval?: ApprovalRequester;
  /** Extra tools beyond the built-ins. Plugins arrive this way. */
  readonly extraTools?: readonly RegisteredTool[];
  readonly limits?: ToolLimits;
  readonly nextId?: IdFactory;
  /** Defaults to `process.platform`. Injectable so both branches are testable. */
  readonly platform?: string;
  readonly hooks?: readonly RegisteredHook[];
  readonly defaultModel?: ModelSelection;
}

interface SessionRuntime {
  readonly session: Session;
  readonly gate: PermissionGate;
  readonly assembler: ContextAssembler;
  readonly continuations: ContinuationStore;
  readonly registry: ToolRegistry;
}

export class Engine {
  private readonly provider: ModelProvider;
  private readonly broker: SandboxBroker;
  private readonly sink: EventSink;
  private readonly fs: EngineFileSystem;
  private readonly store: SessionStore;
  private readonly search: SearchBackend | undefined;
  private readonly requestApproval: ApprovalRequester | undefined;
  private readonly limits: ToolLimits;
  private readonly nextId: IdFactory;
  private readonly platform: string;
  private readonly hooks: HookBus;
  private readonly engineInfo: PeerInfo;
  private readonly defaultModel: ModelSelection;
  private readonly baseTools: readonly RegisteredTool[];
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly completions = new Map<string, Promise<TurnOutcome>>();

  constructor(options: EngineOptions) {
    this.provider = options.provider;
    this.broker = options.broker;
    this.sink = options.sink;
    this.fs = options.fs ?? nodeFileSystem;
    this.store = options.store ?? new InMemorySessionStore();
    this.search = options.search;
    this.requestApproval = options.requestApproval;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.nextId = options.nextId ?? randomIdFactory();
    this.platform = options.platform ?? process.platform;
    this.hooks = new HookBus();
    for (const hook of options.hooks ?? []) this.hooks.register(hook);
    this.engineInfo = options.engineInfo ?? { name: '@adze/core', version: '0.0.1' };
    this.defaultModel = options.defaultModel ?? { provider: 'unset', model: 'unset' };
    this.baseTools = [...builtinTools({ nextId: this.nextId }), ...(options.extraTools ?? [])];
  }

  registerHook(hook: RegisteredHook): Disposable {
    return this.hooks.register(hook);
  }

  /**
   * Version negotiation and an honest capability report.
   *
   * Every `false` below is a roadmap item reporting itself as absent rather than
   * being quietly missing. A surface that reads `retrieval: false` degrades on
   * purpose; a surface that had to discover it by calling `grep` and getting nothing
   * degrades by accident.
   */
  initialize(params: InitializeParams): InitializeResult {
    const negotiated = negotiateProtocolVersion(params.protocolVersions, [
      ...SUPPORTED_PROTOCOL_VERSIONS,
    ]);
    if (!negotiated.ok) throw new Error(negotiated.message);

    const osSandbox = this.broker.enforcement('workspace-write') === 'os-level';
    const capabilities: EngineCapabilities = {
      turns: true,
      edits: true,
      retrieval: this.search !== undefined,
      nativeToolCalling: this.provider.nativeToolCalling,
      // Images cross the protocol and reach the provider as typed attachments; what
      // a given provider does with them is its own capability.
      vision: true,
      mcpClient: false,
      mcpServer: false,
      osSandbox,
    };

    const warnings: Warning[] = [];
    if (!osSandbox) {
      warnings.push({
        code: 'no-os-sandbox',
        message:
          `broker '${this.broker.name}' provides no OS-level containment on ` +
          `${this.platform}. The permission gate and approval policy still apply, but an ` +
          `approved command runs unconfined.`,
        reference: 'docs/architecture/adr/0007-sandbox-and-permissions.md',
      });
    }
    if (!this.provider.nativeToolCalling) {
      warnings.push({
        code: 'degraded-provider',
        message:
          `provider '${this.provider.name}' does not support native tool calling, so turns ` +
          `run without tools. Adze ships no JSON-in-a-string fallback.`,
        reference: 'docs/architecture/adr/0004-tool-surface.md',
      });
    }

    return {
      protocolVersion:
        negotiated.version === PROTOCOL_VERSION ? PROTOCOL_VERSION : negotiated.version,
      engine: this.engineInfo,
      capabilities,
      warnings,
    };
  }

  async sessionCreate(params: SessionCreateParams): Promise<SessionCreateResult> {
    const sandbox: SandboxConfig = params.sandbox ?? {
      mode: DEFAULT_SANDBOX_MODE,
      writableRoots: [],
      allowedNetworkHosts: [],
      commandRules: [],
    };
    const approvals: ApprovalPolicy = params.approvals ?? DEFAULT_APPROVAL_POLICY;
    const model = params.model ?? this.defaultModel;

    const session = new Session({
      id: this.nextId('sess'),
      workspaceRoot: params.workspaceRoot,
      model,
      sandbox,
      approvals,
      ...(params.instructions === undefined ? {} : { instructions: params.instructions }),
    });

    const registry = new ToolRegistry(this.baseTools);
    const gate = this.buildGate(session);
    const assembler = new ContextAssembler({
      model: model.model,
      workspaceRoot: params.workspaceRoot,
      sandboxMode: sandbox.mode,
      approvals,
      enforcement: gate.enforcement(),
      ...(params.instructions === undefined ? {} : { instructions: params.instructions }),
      toolNames: registry.names(),
    });

    await this.store.create(session);
    this.runtimes.set(session.id, {
      session,
      gate,
      assembler,
      registry,
      continuations: new ContinuationStore(() => this.nextId('cont')),
    });

    return {
      sessionId: session.id,
      // What is actually in force, which can differ from what was asked for. A
      // surface must render the real settings: showing the requested mode when the
      // engine narrowed it would be the worst possible lie in a security display.
      sandbox,
      approvals,
      model,
      warnings: [...gate.warnings()],
    };
  }

  async sessionClose(params: SessionCloseParams): Promise<SessionCloseResult> {
    const runtime = this.runtimes.get(params.sessionId);
    if (runtime === undefined) return { turns: 0 };
    runtime.session.activeTurn?.controller.abort();
    runtime.continuations.clear();
    this.runtimes.delete(params.sessionId);
    await this.store.delete(params.sessionId);
    return { usage: runtime.session.usage, turns: runtime.session.turns };
  }

  /**
   * Start a turn and return its id.
   *
   * Returns as soon as the turn is running, because the protocol streams progress as
   * events rather than blocking a request. {@link awaitTurn} is the engine-level
   * convenience for an embedder that wants to wait; it is not a protocol message.
   */
  async turnSubmit(params: TurnSubmitParams): Promise<TurnSubmitResult> {
    const runtime = this.runtimes.get(params.sessionId);
    if (runtime === undefined) throw new Error(`unknown session '${params.sessionId}'`);
    const { session } = runtime;

    if (session.activeTurn !== undefined) {
      throw new Error(
        `session '${session.id}' already has turn '${session.activeTurn.turnId}' in flight; ` +
          `cancel it before submitting another`,
      );
    }

    // A per-turn override changes what is in force, so the gate is rebuilt and the
    // assembler will roll the epoch on the next reconcile. Mutating the existing
    // gate would leave a session-scoped approval memory attached to a policy the
    // user no longer chose.
    if (params.sandbox !== undefined) session.sandbox = params.sandbox;
    if (params.approvals !== undefined) session.approvals = params.approvals;
    const gate =
      params.sandbox !== undefined || params.approvals !== undefined
        ? this.buildGate(session)
        : runtime.gate;
    if (gate !== runtime.gate) {
      this.runtimes.set(session.id, { ...runtime, gate });
    }

    const turnId = this.nextId('turn');
    const controller = new AbortController();
    session.activeTurn = { turnId, controller };

    const emitter = new TurnEmitter(this.sink, session.id, turnId);
    const completion = runTurn(
      {
        session,
        turnId,
        prompt: params.prompt,
        attachments: params.attachments,
        budget: params.budget ?? {},
        emitter,
        signal: controller.signal,
      },
      {
        provider: this.provider,
        registry: runtime.registry,
        gate,
        hooks: this.hooks,
        assembler: runtime.assembler,
        continuations: runtime.continuations,
        limits: this.limits,
        search: this.search,
        runSubagent: this.subagentRunner(session.id, turnId),
      },
    ).finally(() => {
      session.activeTurn = undefined;
    });

    this.completions.set(turnId, completion);
    // Rejections are surfaced through `awaitTurn`. Attaching a no-op catch here stops
    // a submit-and-forget caller from crashing the process on an unhandled rejection,
    // which would turn a configuration error into a dead engine.
    completion.catch(() => undefined);

    return { turnId };
  }

  /** Wait for a submitted turn. Engine-level convenience, not a protocol message. */
  async awaitTurn(turnId: string): Promise<TurnOutcome> {
    const completion = this.completions.get(turnId);
    if (completion === undefined) throw new Error(`unknown turn '${turnId}'`);
    try {
      return await completion;
    } finally {
      this.completions.delete(turnId);
    }
  }

  turnCancel(params: TurnCancelParams): TurnCancelResult {
    const runtime = this.runtimes.get(params.sessionId);
    const active = runtime?.session.activeTurn;
    // False rather than an error when the turn already finished: a cancel racing a
    // completion is normal, and making it an error would force every surface to
    // special-case a race it cannot avoid.
    if (active === undefined || active.turnId !== params.turnId) return { cancelled: false };
    active.controller.abort();
    return { cancelled: true };
  }

  /** For embedders and tests. Not a protocol message. */
  async session(id: string): Promise<Session | undefined> {
    return await this.store.get(id);
  }

  private buildGate(session: Session): PermissionGate {
    return new PermissionGate({
      workspaceRoot: session.workspaceRoot,
      sandbox: session.sandbox,
      approvals: session.approvals,
      broker: this.broker,
      fs: this.fs,
      nextRequestId: () => this.nextId('appr'),
      platform: this.platform,
      ...(this.requestApproval === undefined ? {} : { requestApproval: this.requestApproval }),
    });
  }

  /**
   * The `task` tool's runner.
   *
   * A subagent is the same boring loop with a narrowed tool list, its own budget, and
   * a fresh session that shares the parent's workspace, sandbox mode, and approval
   * policy. It gets a fresh history on purpose: the parent's conversation is exactly
   * the context delegation exists to avoid re-sending.
   *
   * It cannot widen the parent's allowlist, because {@link ToolRegistry.narrow}
   * filters rather than looks up. `task` is excluded from its own tool set so a
   * subagent cannot spawn subagents — unbounded recursion through a tool call is a
   * budget nobody set.
   */
  private subagentRunner(parentSessionId: string, parentTurnId: string): SubagentRunner {
    return async (request: SubagentRequest): Promise<SubagentResult> => {
      const parent = this.runtimes.get(parentSessionId);
      if (parent === undefined) {
        return { ok: false, text: '', steps: 0, stopReason: 'error', error: 'parent session gone' };
      }

      const requested = request.tools.filter((name) => name !== 'task');
      const narrowed = parent.registry.narrow(requested);
      if (!narrowed.ok) {
        return {
          ok: false,
          text: '',
          steps: 0,
          stopReason: 'error',
          error:
            `unknown tool(s): ${narrowed.unknown.join(', ')}. ` +
            `Available: ${parent.registry
              .names()
              .filter((n) => n !== 'task')
              .join(', ')}.`,
        };
      }

      const child = new Session({
        id: `${parentSessionId}~${this.nextId('sub')}`,
        workspaceRoot: parent.session.workspaceRoot,
        model: parent.session.model,
        sandbox: parent.session.sandbox,
        approvals: parent.session.approvals,
      });

      const assembler = new ContextAssembler({
        model: child.model.model,
        workspaceRoot: child.workspaceRoot,
        sandboxMode: child.sandbox.mode,
        approvals: child.approvals,
        enforcement: parent.gate.enforcement(),
        toolNames: narrowed.registry.names(),
      });

      const turnId = `${parentTurnId}~${this.nextId('subturn')}`;
      const outcome = await runTurn(
        {
          session: child,
          turnId,
          prompt: request.prompt,
          attachments: [],
          budget: { maxSteps: request.maxSteps ?? DEFAULT_SUBAGENT_STEPS },
          emitter: new TurnEmitter(this.sink, child.id, turnId),
          signal: parent.session.activeTurn?.controller.signal ?? new AbortController().signal,
        },
        {
          provider: this.provider,
          registry: narrowed.registry,
          // The parent's gate, so the subagent's calls are authorized under the same
          // policy and share the session's approval memory. A fresh gate would ask the
          // user again for something they already approved this session.
          gate: parent.gate,
          hooks: this.hooks,
          assembler,
          continuations: parent.continuations,
          limits: this.limits,
          search: this.search,
          // No nesting. See the doc comment.
          runSubagent: undefined,
        },
      );

      return {
        ok: outcome.stopReason === 'end-turn',
        text: outcome.text,
        steps: outcome.steps,
        stopReason: outcome.stopReason,
        ...(outcome.message === undefined ? {} : { error: outcome.message }),
      };
    };
  }
}

/** Re-exported so an embedder can type its sink without importing the protocol. */
export type { AdzeEvent };
