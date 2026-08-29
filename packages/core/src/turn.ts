/**
 * The turn machine.
 *
 * ADR-0003 in code, and it is deliberately boring. That is a conclusion from
 * evidence, not taste: controlled experiments holding the model fixed and swapping
 * the harness found aggregate score differences that were **not statistically
 * significant**, while the minimal reference harness — bash-only, strictly linear
 * history, one subprocess per action — scores at or above elaborate ones. Elaborate
 * scaffolding buys perhaps 10–15 points against a *bad* baseline and close to
 * nothing against a good one. So the complexity budget goes to the applier, the
 * gate, and the context assembler instead.
 *
 * ```
 * submit(prompt)
 *   → fire session.turnStart hooks
 *   → assemble context for the current cache epoch
 *   → loop until stop | budget exhausted | max steps:
 *       stream model response (native tool calling)
 *       for each tool call:
 *         fire tool.pre hooks        (may deny or rewrite args)
 *         authorize via permission gate
 *         execute in sandbox         (stateless: one subprocess per call)
 *         truncate + structure result
 *         fire tool.post hooks
 *       append to a strictly linear history
 *   → fire session.turnEnd hooks
 *   → report usage, cost, cache hit rate
 * ```
 *
 * What is **not** here, and will not be: tree search, a planner/executor split, a
 * reflection layer. Anyone who wants those builds them as a subagent through the
 * `task` tool or as a plugin. Keeping them out is the decision; the `task` tool is
 * the escape hatch that makes keeping them out cheap.
 *
 * ### A step is a model round-trip plus its tool calls
 *
 * With `maxSteps: 1` the model is called once, any tools it asked for run, and the
 * loop then stops with `max-steps`. Cutting the tools off instead would leave an
 * assistant message with unanswered calls — a history most providers reject, and one
 * that cannot be replayed. So the step boundary sits after tool execution.
 *
 * ### Cancellation leaves a valid history
 *
 * A turn cancelled between tool calls has an assistant message asking for N tools
 * and fewer than N answers. Rather than leave that, the machine appends synthetic
 * failed results for the calls that never ran. History stays strictly linear, the
 * next turn is valid, and the trajectory records exactly what happened.
 */

import type {
  Attachment,
  ContentBlock,
  StopReason,
  ToolCall,
  ToolResult,
  TurnBudget,
  Usage,
  Warning,
} from '@adze/protocol';
import { BudgetTracker, type Clock, systemClock } from './budget.js';
import type { BaselineInputs, ContextAssembler } from './context.js';
import { addUsage, ZERO_USAGE } from './cost.js';
import { dispatchToolCall } from './dispatch.js';
import type { TurnEmitter } from './events.js';
import type { HookBus } from './hooks.js';
import type { PermissionGate } from './permissions.js';
import type { ModelProvider, ModelStreamChunk } from './provider.js';
import type { ToolRegistry, ToolSpec } from './registry.js';
import type { SearchBackend } from './retrieval.js';
import type { Session } from './session.js';
import type { ContinuationStore } from './truncate.js';
import type { ConversationMessage, SubagentRunner, ToolEmission, ToolLimits } from './types.js';

export interface TurnDeps {
  readonly provider: ModelProvider;
  readonly registry: ToolRegistry;
  readonly gate: PermissionGate;
  readonly hooks: HookBus;
  readonly assembler: ContextAssembler;
  readonly continuations: ContinuationStore;
  readonly limits: ToolLimits;
  readonly search: SearchBackend | undefined;
  readonly runSubagent: SubagentRunner | undefined;
  readonly clock?: Clock;
}

export interface TurnRequest {
  readonly session: Session;
  readonly turnId: string;
  readonly prompt: string;
  readonly attachments: readonly Attachment[];
  readonly budget: TurnBudget;
  readonly emitter: TurnEmitter;
  readonly signal: AbortSignal;
  /** Extra warnings for `turn.started`, e.g. a degraded provider. */
  readonly warnings?: readonly Warning[];
}

export interface TurnOutcome {
  readonly turnId: string;
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly steps: number;
  /** Concatenated assistant text. What a subagent's caller receives. */
  readonly text: string;
  readonly message?: string;
}

/** Raised at submit for a configuration that cannot be honoured. */
export class TurnConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnConfigurationError';
  }
}

export async function runTurn(request: TurnRequest, deps: TurnDeps): Promise<TurnOutcome> {
  const { session, emitter, turnId } = request;
  const clock = deps.clock ?? systemClock;
  const prices = deps.provider.priceFor(session.model);
  const budget = new BudgetTracker(request.budget, prices, clock);

  // A spend ceiling that cannot be computed is refused rather than ignored.
  // Accepting it and not applying it is the money-shaped version of a permission
  // policy that grants more than it advertises.
  if (budget.spendUnenforceable) {
    throw new TurnConfigurationError(
      `budget.maxSpendUsd was set but provider '${deps.provider.name}' has no prices for ` +
        `model '${session.model.model}', so the budget could not be enforced. Configure ` +
        `prices or remove the spend budget.`,
    );
  }

  const toolsEnabled = deps.provider.nativeToolCalling;
  deps.assembler.reconcile(baselineInputs(session, deps, toolsEnabled));

  const warnings: Warning[] = [
    ...deps.gate.warnings(),
    ...(request.warnings ?? []),
    ...(toolsEnabled
      ? []
      : [
          {
            code: 'degraded-provider' as const,
            message:
              `provider '${deps.provider.name}' does not support native tool calling, so this ` +
              `turn runs without tools. Adze ships no JSON-in-a-string fallback: that path ` +
              `carries a measured ~7% invalid-JSON rejection rate.`,
            reference: 'docs/architecture/adr/0004-tool-surface.md',
          },
        ]),
  ];

  emitter.turnStarted(session.model.model, deps.assembler.current.index, warnings);

  const injected = await deps.hooks.fireTurnStart({
    sessionId: session.id,
    turnId,
    prompt: request.prompt,
    cacheEpoch: deps.assembler.current.index,
  });

  // Hook-injected context rides as an ordered message, never as a change to the
  // frozen prefix — mutating the prefix would invalidate the cache for the epoch.
  if (injected.length > 0) {
    session.append({ role: 'user', origin: 'hook', content: injected });
  }
  session.append({
    role: 'user',
    origin: 'user',
    content: userContent(request.prompt, request.attachments),
  });

  const state: LoopState = {
    usage: ZERO_USAGE,
    text: '',
    stopReason: 'end-turn',
    message: undefined,
  };

  await loop(request, deps, budget, state, toolsEnabled);

  session.recordUsage(state.usage);
  session.turns += 1;

  await deps.hooks.fireTurnEnd({
    sessionId: session.id,
    turnId,
    stopReason: state.stopReason,
    usage: state.usage,
    steps: budget.stepsTaken,
  });

  emitter.turnCompleted(
    state.stopReason,
    session.model.model,
    state.usage,
    budget.stepsTaken,
    state.message,
  );

  return {
    turnId,
    stopReason: state.stopReason,
    usage: state.usage,
    steps: budget.stepsTaken,
    text: state.text,
    ...(state.message === undefined ? {} : { message: state.message }),
  };
}

interface LoopState {
  usage: Usage;
  text: string;
  stopReason: StopReason;
  message: string | undefined;
}

/**
 * Why the loop should stop before making another model call.
 *
 * Extracted so `loop` stays readable and so the precedence — cancellation first, then
 * budgets in their fixed order — is stated in one place rather than as a sequence of
 * early returns interleaved with the work.
 */
function preflight(request: TurnRequest, budget: BudgetTracker): Partial<LoopState> | undefined {
  if (request.signal.aborted) {
    return { stopReason: 'cancelled', message: 'the turn was cancelled' };
  }
  const exhausted = budget.check();
  if (exhausted !== undefined) {
    return { stopReason: exhausted.stopReason, message: exhausted.message };
  }
  return undefined;
}

async function loop(
  request: TurnRequest,
  deps: TurnDeps,
  budget: BudgetTracker,
  state: LoopState,
  toolsEnabled: boolean,
): Promise<void> {
  const catalog = toolsEnabled ? deps.registry.catalog() : [];

  for (;;) {
    const stop = preflight(request, budget);
    if (stop !== undefined) {
      Object.assign(state, stop);
      return;
    }
    const finished = await runStep(request, deps, budget, state, toolsEnabled, catalog);
    if (finished) return;
  }
}

/**
 * One step: a model round-trip plus the tool calls it produced.
 *
 * Returns true when the loop should stop. The step boundary sits *after* tool
 * execution deliberately — cutting the tools off would leave an assistant message with
 * unanswered calls, which most providers reject and which cannot be replayed.
 */
async function runStep(
  request: TurnRequest,
  deps: TurnDeps,
  budget: BudgetTracker,
  state: LoopState,
  toolsEnabled: boolean,
  catalog: readonly ToolSpec[],
): Promise<boolean> {
  const { session, emitter, signal } = request;

  // Checked every step so a mid-turn model or permission change is caught without the
  // caller having to announce it. Within an epoch this is a no-op, which is exactly the
  // point: the prefix stays byte-identical.
  deps.assembler.reconcile(baselineInputs(session, deps, toolsEnabled));
  const assembled = deps.assembler.assemble(session.history);

  let streamed: StreamOutcome;
  try {
    streamed = await consumeStream(
      deps.provider.stream({
        model: session.model,
        messages: assembled.messages,
        tools: catalog,
        signal,
        cachePrefixLength: assembled.cachePrefixLength,
      }),
      emitter,
    );
  } catch (error) {
    state.stopReason = 'error';
    state.message = `model request failed: ${error instanceof Error ? error.message : String(error)}`;
    return true;
  }

  if (streamed.usage !== undefined) {
    state.usage = addUsage(state.usage, streamed.usage);
    budget.recordUsage(state.usage);
  }
  state.text += streamed.text;
  budget.recordStep();
  emitter.usageUpdated(session.model.model, state.usage, budget.stepsTaken);

  // Cancelled mid-stream: nothing is appended, so there is no assistant message with
  // unanswered tool calls and the history stays valid for the next turn.
  if (signal.aborted) {
    state.stopReason = 'cancelled';
    state.message = 'the turn was cancelled while the model was responding';
    return true;
  }

  session.append({
    role: 'assistant',
    origin: 'model',
    content: streamed.text.length > 0 ? [{ type: 'text', text: streamed.text }] : [],
    toolCalls: streamed.calls,
  });

  if (streamed.calls.length === 0) {
    state.stopReason = streamed.finishReason === 'error' ? 'error' : 'end-turn';
    if (streamed.finishReason === 'error') state.message = streamed.message;
    return true;
  }

  const tools = await runToolCalls(request, deps, streamed.calls, budget.stepsTaken);
  session.append(...tools.messages);

  if (tools.abort) {
    state.stopReason = 'refused';
    state.message = tools.abortReason;
    return true;
  }
  if (tools.cancelled) {
    state.stopReason = 'cancelled';
    state.message = 'the turn was cancelled while tools were running';
    return true;
  }
  return false;
}

interface ToolPhaseOutcome {
  readonly messages: readonly ConversationMessage[];
  readonly abort: boolean;
  readonly abortReason: string | undefined;
  readonly cancelled: boolean;
}

async function runToolCalls(
  request: TurnRequest,
  deps: TurnDeps,
  calls: readonly ToolCall[],
  step: number,
): Promise<ToolPhaseOutcome> {
  const { session, emitter, signal } = request;
  const messages: ConversationMessage[] = [];
  let abort = false;
  let abortReason: string | undefined;
  let cancelled = false;

  for (const call of calls) {
    if (abort || cancelled || signal.aborted) {
      // Synthetic results for calls that never ran. An assistant message with
      // unanswered tool calls is rejected by most providers and cannot be replayed,
      // so the history is completed rather than left ragged.
      cancelled = cancelled || signal.aborted;
      messages.push(
        toolMessage(call, {
          callId: call.callId,
          ok: false,
          content: [
            {
              type: 'text',
              text: abort
                ? 'not run: the turn was aborted by an earlier decision'
                : 'not run: the turn was cancelled',
            },
          ],
          truncated: false,
          error: abort ? 'aborted' : 'cancelled',
        }),
      );
      continue;
    }

    const outcome = await dispatchToolCall(
      { callId: call.callId, name: call.name, arguments: call.arguments, step },
      {
        registry: deps.registry,
        gate: deps.gate,
        hooks: deps.hooks,
        continuations: deps.continuations,
        workspaceRoot: session.workspaceRoot,
        sessionId: session.id,
        turnId: request.turnId,
        limits: deps.limits,
        signal,
        search: deps.search,
        todos: session.todos,
        runSubagent: deps.runSubagent,
      },
    );

    if (outcome.kind === 'denied') {
      emitter.toolDenied(call.callId, call.name, outcome.source, outcome.reason);
      messages.push(
        toolMessage(call, {
          callId: call.callId,
          ok: false,
          content: [{ type: 'text', text: `denied: ${outcome.reason}` }],
          truncated: false,
          error: 'denied',
        }),
      );
      if (outcome.abort) {
        abort = true;
        abortReason = outcome.reason;
      }
      continue;
    }

    // Emitted only after authorization, so `tool.started` in a trajectory means the
    // tool actually ran rather than that a call was attempted.
    emitter.toolStarted(call, step);
    applyEmissions(outcome.emissions, session, emitter);
    emitter.toolFinished(outcome.result);
    messages.push(toolMessage(call, outcome.result));
  }

  return { messages, abort, abortReason, cancelled };
}

/**
 * Apply a tool's emissions to session state and the event stream.
 *
 * Tools never construct events, so `seq` integrity and the "engine renders nothing"
 * rule both survive a tool that wants to report something structured.
 */
function applyEmissions(
  emissions: readonly ToolEmission[],
  session: Session,
  emitter: TurnEmitter,
): void {
  for (const emission of emissions) {
    switch (emission.kind) {
      case 'edit.proposed':
        emitter.editProposed(emission.proposal);
        break;
      case 'edit.applied':
        emitter.editApplied(emission.applied);
        break;
      case 'edit.refused':
        emitter.editRefused(emission.refused);
        break;
      case 'todo.updated':
        session.todos = emission.items;
        emitter.todoUpdated(emission.items);
        break;
    }
  }
}

function toolMessage(call: ToolCall, result: ToolResult): ConversationMessage {
  return {
    role: 'tool',
    origin: 'tool',
    callId: result.callId,
    name: call.name,
    ok: result.ok,
    content: [...result.content],
  };
}

interface StreamOutcome {
  readonly text: string;
  readonly calls: readonly ToolCall[];
  readonly usage: Usage | undefined;
  readonly finishReason: string | undefined;
  readonly message: string | undefined;
}

async function consumeStream(
  stream: AsyncIterable<ModelStreamChunk>,
  emitter: TurnEmitter,
): Promise<StreamOutcome> {
  let text = '';
  const calls: ToolCall[] = [];
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  let message: string | undefined;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text;
        // Forwarded incrementally; the engine does not buffer for the surface.
        emitter.textDelta(chunk.text);
        break;
      case 'tool-call':
        calls.push({ callId: chunk.callId, name: chunk.name, arguments: chunk.arguments });
        break;
      case 'finish':
        usage = chunk.usage;
        finishReason = chunk.finishReason;
        message = chunk.message;
        break;
    }
  }

  return { text, calls, usage, finishReason, message };
}

function userContent(prompt: string, attachments: readonly Attachment[]): readonly ContentBlock[] {
  return [{ type: 'text', text: prompt }, ...attachments];
}

function baselineInputs(session: Session, deps: TurnDeps, toolsEnabled: boolean): BaselineInputs {
  return {
    model: session.model.model,
    workspaceRoot: session.workspaceRoot,
    sandboxMode: session.sandbox.mode,
    approvals: session.approvals,
    enforcement: deps.gate.enforcement(),
    ...(session.instructions === undefined ? {} : { instructions: session.instructions }),
    toolNames: toolsEnabled ? deps.registry.names() : [],
  };
}
