/**
 * The client and session implementations.
 *
 * A thin facade, and thin is the point: the turn machine, the budgets, the gate, and
 * the epoch assembler all stay in `@adze/core`. What this adds is the part every
 * surface would otherwise write for itself and get subtly differently — event
 * fan-out, a cancellable turn handle, usage and cost roll-up, error translation, and
 * a disposal path that leaves nothing running.
 *
 * ## What this file deliberately does not add
 *
 * There is no way to skip the permission gate, and no `trustEverything` flag. The
 * closest thing to one is `sandbox.mode: 'full-access'`, which is core's own setting,
 * is reported in `warnings` as `network-unrestricted`, and still routes every call
 * through the gate. A convenience that bypassed it would make the whole trust model
 * decorative (ADR-0007, architecture invariant 4).
 *
 * There is also no rendering. No colour, no escapes, no markdown, nothing written to
 * a stream. Consumers get structured events and decide (ADR-0001 rule 1).
 */

import { addUsage, Engine, TurnConfigurationError, type TurnOutcome, ZERO_USAGE } from '@adze/core';
import type {
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  Cost,
  EngineCapabilities,
  ModelSelection,
  PeerInfo,
  SandboxConfig,
  TurnBudget,
  Usage,
  Warning,
} from '@adze/protocol';
import {
  ApprovalResponseSchema,
  refusesRatherThanPrompts,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@adze/protocol';
import { AdzeConfigError, AdzeSessionError } from '../errors.js';
import type {
  AdzeClient,
  AdzeClientOptions,
  AdzeSession,
  ApprovalHandler,
  EventListener,
  SessionOptions,
  SessionUsageReport,
  TurnHandle,
  TurnInput,
  TurnResult,
  Unsubscribe,
} from '../types.js';
import { EventBus } from './bus.js';
import {
  buildSandbox,
  costFor,
  requireBudget,
  requirePrices,
  type ValidatedConfig,
  validateClientOptions,
} from './validate.js';

/**
 * Build a client.
 *
 * Synchronous, because everything it does is synchronous: validation, engine
 * construction, and version negotiation. Making it a promise would suggest I/O that
 * does not happen, and no network call is made here or anywhere else in this package
 * — only a configured provider talks to the outside (architecture invariant 5).
 */
export function createClient(options: AdzeClientOptions): AdzeClient {
  return new ClientImpl(options);
}

class ClientImpl implements AdzeClient {
  readonly protocolVersion: string;
  readonly capabilities: EngineCapabilities;
  readonly engine: PeerInfo;
  readonly warnings: readonly Warning[];
  readonly model: ModelSelection;

  private readonly engineImpl: Engine;
  private readonly bus: EventBus;
  private readonly config: ValidatedConfig;
  private readonly sessions = new Set<SessionImpl>();
  private readonly approvals: ApprovalRouter | undefined;
  private disposed = false;

  constructor(options: AdzeClientOptions) {
    this.config = validateClientOptions(options);
    this.bus = new EventBus(options.onListenerError);
    this.model = this.config.model;

    this.approvals =
      options.onApprovalRequest === undefined
        ? undefined
        : new ApprovalRouter(options.onApprovalRequest, () => this.promptingIsPossible());

    this.engineImpl = new Engine({
      provider: this.config.provider,
      broker: this.config.broker,
      sink: this.bus.publish,
      defaultModel: this.config.model,
      extraTools: this.config.tools,
      hooks: this.config.hooks,
      ...(this.config.search === undefined ? {} : { search: this.config.search }),
      ...(this.config.limits === undefined ? {} : { limits: this.config.limits }),
      // Omitted entirely when the consumer supplied no handler, so core's own
      // "no approval channel is connected" refusal is what a user sees rather than a
      // stand-in of ours that would have to duplicate its wording.
      ...(this.approvals === undefined ? {} : { requestApproval: this.approvals.request }),
    });

    const init = this.engineImpl.initialize({
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      client: { ...this.config.client, platform: this.config.client.platform ?? process.platform },
    });

    this.protocolVersion = init.protocolVersion;
    this.capabilities = init.capabilities;
    this.engine = init.engine;
    this.warnings = init.warnings;
  }

  subscribe(listener: EventListener): Unsubscribe {
    this.assertLive();
    return this.bus.subscribe(listener);
  }

  async createSession(options: SessionOptions = {}): Promise<AdzeSession> {
    this.assertLive();
    const model = options.model ?? this.config.model;
    const sandbox =
      options.sandbox === undefined ? this.config.sandbox : buildSandbox(options.sandbox);
    const instructions = options.instructions ?? this.config.instructions;

    const created = await this.engineImpl.sessionCreate({
      workspaceRoot: this.config.workspaceRoot,
      model,
      sandbox,
      approvals: options.approvals ?? this.config.approvals,
      ...(instructions === undefined ? {} : { instructions }),
    });

    const session = new SessionImpl({
      // Everything below is what the engine reports as actually in force, which can
      // differ from what was asked for. Reporting the request instead would be the
      // worst possible lie in a security display.
      id: created.sessionId,
      sandbox: created.sandbox,
      approvals: created.approvals,
      model: created.model,
      warnings: created.warnings,
      engine: this.engineImpl,
      bus: this.bus,
      defaultBudget: this.config.budget,
      costFor: (selection, usage) => costFor(this.config.provider, selection, usage),
      requirePrices: (selection, field) => {
        requirePrices(this.config.provider, selection, field);
      },
      onClosed: (closed) => this.sessions.delete(closed),
    });
    this.sessions.add(session);
    return session;
  }

  /**
   * Whether any live session could legitimately produce an approval request.
   *
   * Belt and braces over the gate, which already refuses under `never` rather than
   * escalating: if every live session is `never`, no request reaching the router can
   * be legitimate, so the consumer's handler is not consulted at all. Even a gate
   * regression therefore cannot turn a `never` policy into a prompt.
   *
   * It is a conservative approximation rather than an exact answer, and the reason is
   * a protocol gap: `ApprovalRequest` carries no `sessionId`, so a router holding two
   * sessions cannot tell which one asked. With one session — the ordinary case, and
   * the one the tests pin — the approximation is exact.
   */
  private promptingIsPossible(): boolean {
    for (const session of this.sessions) {
      if (!refusesRatherThanPrompts(session.approvals)) return true;
    }
    return false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Snapshot first: close() removes each session from the set as it completes.
    await Promise.all([...this.sessions].map(async (session) => await session.close()));
    this.sessions.clear();
    // Dropped rather than muted, so a leaked subscription is observable as a leak
    // instead of quietly retaining whatever the listener closed over.
    this.bus.clear();
  }

  private assertLive(): void {
    if (this.disposed) throw new AdzeSessionError('this client has been disposed');
  }
}

interface SessionDeps {
  readonly id: string;
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly model: ModelSelection;
  readonly warnings: readonly Warning[];
  readonly engine: Engine;
  readonly bus: EventBus;
  readonly defaultBudget: TurnBudget | undefined;
  readonly costFor: (model: ModelSelection, usage: Usage) => Cost | undefined;
  readonly requirePrices: (model: ModelSelection, field: string) => void;
  readonly onClosed: (session: SessionImpl) => void;
}

class SessionImpl implements AdzeSession {
  readonly id: string;
  readonly model: ModelSelection;
  readonly warnings: readonly Warning[];

  private sandboxConfig: SandboxConfig;
  private approvalPolicy: ApprovalPolicy;
  private usageTotal: Usage = ZERO_USAGE;
  private turnCount = 0;
  private active: TurnHandleImpl | undefined;
  private closed = false;

  constructor(private readonly deps: SessionDeps) {
    this.id = deps.id;
    this.model = deps.model;
    this.warnings = deps.warnings;
    this.sandboxConfig = deps.sandbox;
    this.approvalPolicy = deps.approvals;
  }

  get sandbox(): SandboxConfig {
    return this.sandboxConfig;
  }

  get approvals(): ApprovalPolicy {
    return this.approvalPolicy;
  }

  subscribe(listener: EventListener): Unsubscribe {
    return this.deps.bus.subscribe(listener, this.id);
  }

  async submit(input: TurnInput): Promise<TurnHandle> {
    if (this.closed) throw new AdzeSessionError(`session '${this.id}' is closed`);
    if (input.prompt.trim().length === 0) throw new AdzeConfigError('prompt must not be empty');

    const budget =
      input.budget === undefined ? this.deps.defaultBudget : requireBudget(input.budget);
    // Refused here rather than from inside the turn, where the same problem arrives as
    // a rejected turn instead of as a configuration error naming the field.
    if (budget?.maxSpendUsd !== undefined) {
      this.deps.requirePrices(this.model, 'budget.maxSpendUsd');
    }
    const sandbox = input.sandbox === undefined ? undefined : buildSandbox(input.sandbox);

    let turnId: string;
    try {
      const submitted = await this.deps.engine.turnSubmit({
        sessionId: this.id,
        prompt: input.prompt,
        attachments: [...(input.attachments ?? [])],
        ...(budget === undefined ? {} : { budget }),
        ...(sandbox === undefined ? {} : { sandbox }),
        ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
      });
      turnId = submitted.turnId;
    } catch (error) {
      throw translateSubmitError(error, this.id);
    }

    // A per-turn override is what is now in force for the session, so the accessors
    // report it. A security display showing the session's original setting while a
    // wider one was active would be the worst possible kind of stale.
    if (sandbox !== undefined) this.sandboxConfig = sandbox;
    if (input.approvals !== undefined) this.approvalPolicy = input.approvals;

    const handle = new TurnHandleImpl({
      turnId,
      engine: this.deps.engine,
      sessionId: this.id,
      report: (usage) => this.reportFor(usage),
      onSettled: (outcome) => {
        this.usageTotal = addUsage(this.usageTotal, outcome.usage);
        this.turnCount += 1;
        this.active = undefined;
      },
    });
    this.active = handle;
    return handle;
  }

  async run(input: TurnInput): Promise<TurnResult> {
    const handle = await this.submit(input);
    return await handle.result();
  }

  /**
   * Session totals.
   *
   * Accumulated from the turns submitted through this session, which is the same
   * accounting core keeps: a subagent's tokens are recorded against the child session
   * core created for it, not folded into the parent's.
   */
  usage(): SessionUsageReport {
    return { ...this.reportFor(this.usageTotal), turns: this.turnCount };
  }

  async close(): Promise<SessionUsageReport> {
    if (this.closed) return this.usage();
    this.closed = true;
    this.active?.cancel();
    // Awaited so a cancelled turn has finished unwinding before the session goes away.
    // Skipping it is how a disposed client leaves a turn still writing into a session
    // nobody is listening to.
    await this.active?.settled();
    await this.deps.engine.sessionClose({ sessionId: this.id });
    this.deps.onClosed(this);
    return this.usage();
  }

  private reportFor(usage: Usage): {
    readonly usage: Usage;
    readonly cost: Cost | undefined;
    readonly cacheHitRate: number;
  } {
    return {
      usage,
      cost: this.deps.costFor(this.model, usage),
      cacheHitRate: usage.cacheHitRate,
    };
  }
}

interface TurnHandleDeps {
  readonly turnId: string;
  readonly engine: Engine;
  readonly sessionId: string;
  readonly report: (usage: Usage) => {
    readonly usage: Usage;
    readonly cost: Cost | undefined;
    readonly cacheHitRate: number;
  };
  readonly onSettled: (outcome: TurnOutcome) => void;
}

class TurnHandleImpl implements TurnHandle {
  readonly turnId: string;
  private promise: Promise<TurnResult> | undefined;

  constructor(private readonly deps: TurnHandleDeps) {
    this.turnId = deps.turnId;
  }

  cancel(): boolean {
    return this.deps.engine.turnCancel({ sessionId: this.deps.sessionId, turnId: this.turnId })
      .cancelled;
  }

  /**
   * The turn's result.
   *
   * Memoized because core's `awaitTurn` is single-shot — it forgets a turn once
   * awaited — and a handle whose second `result()` threw `unknown turn` would trap any
   * consumer that both awaits the turn and reports on it.
   */
  result(): Promise<TurnResult> {
    this.promise ??= this.collect();
    return this.promise;
  }

  /** Resolves once the turn is over, whether it ended, refused, or threw. */
  async settled(): Promise<void> {
    try {
      await this.result();
    } catch {
      // Deliberately swallowed: this exists so `close` can wait, and the failure was
      // already delivered to whoever called `result()`.
    }
  }

  private async collect(): Promise<TurnResult> {
    let outcome: TurnOutcome;
    try {
      outcome = await this.deps.engine.awaitTurn(this.turnId);
    } catch (error) {
      throw translateTurnError(error);
    }
    this.deps.onSettled(outcome);
    return {
      turnId: outcome.turnId,
      stopReason: outcome.stopReason,
      text: outcome.text,
      steps: outcome.steps,
      ...this.deps.report(outcome.usage),
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
    };
  }
}

/**
 * Routes an approval request to the consumer's handler, and refuses when it cannot.
 *
 * Every failure mode lands on `deny` rather than on `allow-once`. That direction is
 * the whole design: a handler that throws, returns a malformed response, or answers a
 * different request has not produced consent, and treating any of those as consent
 * would make the approval channel a formality.
 */
class ApprovalRouter {
  /** How many times the consumer's handler was called. Asserted in tests. */
  invocations = 0;

  constructor(
    private readonly handler: ApprovalHandler,
    private readonly promptingIsPossible: () => boolean,
  ) {}

  readonly request = async (incoming: ApprovalRequest): Promise<ApprovalResponse> => {
    if (!this.promptingIsPossible()) {
      return deny(
        incoming,
        "the approval policy in force is 'never', which refuses rather than escalating",
      );
    }

    let answered: ApprovalResponse;
    try {
      this.invocations += 1;
      answered = await this.handler(incoming);
    } catch (error) {
      return deny(incoming, `the approval handler threw: ${messageOf(error)}`);
    }

    const parsed = ApprovalResponseSchema.safeParse(answered);
    if (!parsed.success) {
      return deny(incoming, 'the approval handler returned a malformed response');
    }
    if (parsed.data.requestId !== incoming.requestId) {
      return deny(incoming, 'the approval handler answered a different request');
    }
    return parsed.data;
  };
}

function deny(request: ApprovalRequest, note: string): ApprovalResponse {
  return { requestId: request.requestId, decision: 'deny', note };
}

function translateSubmitError(error: unknown, sessionId: string): Error {
  const message = messageOf(error);
  if (message.includes('already has turn')) {
    return new AdzeSessionError(
      `session '${sessionId}' already has a turn in flight. Cancel it before submitting ` +
        `another, or create a second session.`,
    );
  }
  if (message.includes('unknown session')) {
    return new AdzeSessionError(`session '${sessionId}' is no longer known to the engine`);
  }
  return error instanceof Error ? error : new AdzeSessionError(message);
}

function translateTurnError(error: unknown): Error {
  // Core's own configuration error, re-clothed. A consumer catching
  // `TurnConfigurationError` would have taken a dependency on a core internal, and a
  // rename inside core would then be a breaking change for them.
  if (error instanceof TurnConfigurationError) return new AdzeConfigError(error.message);
  return error instanceof Error ? error : new AdzeSessionError(messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
