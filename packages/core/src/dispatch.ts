/**
 * The tool dispatcher.
 *
 * **This is the only place in the engine that calls a tool's `execute`.** That is
 * not a convention; it is the mechanism behind architecture invariant 4 — every
 * tool call passes the permission gate, including built-ins, with no code path
 * around it. Three things make it hold:
 *
 * 1. `execute` requires a {@link Grant}, and only {@link PermissionGate.authorize}
 *    can produce one. A caller who wanted to skip the gate would have to forge a
 *    branded type it cannot name.
 * 2. Arguments reach `execute` only through `prepare`, so schema validation is not
 *    a step anyone can forget to take.
 * 3. `test/gate-coverage.test.ts` asserts the property from two directions: no
 *    source file outside this one contains a call to `.execute(`, and with a
 *    denying gate no built-in tool's body runs.
 *
 * The order below is ADR-0003's, exactly: `tool.pre` hooks, then the gate, then
 * execution, then truncation, then `tool.post` hooks. Hooks come *before* the gate
 * so a plugin can veto without the user being prompted first — being asked to
 * approve something a local policy already forbids is worse than not being asked.
 */

import type { JsonObject, TodoItem, ToolResult } from '@adze/protocol';
import type { HookBus } from './hooks.js';
import { PermissionError, type PermissionGate } from './permissions.js';
import type { ToolRegistry } from './registry.js';
import type { SearchBackend } from './retrieval.js';
import { type ContinuationStore, truncateContent } from './truncate.js';
import type {
  ContinuationResolver,
  Effect,
  SubagentRunner,
  ToolContext,
  ToolEmission,
  ToolLimits,
} from './types.js';

export interface DispatchRequest {
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly step: number;
}

export interface DispatchDeps {
  readonly registry: ToolRegistry;
  readonly gate: PermissionGate;
  readonly hooks: HookBus;
  readonly continuations: ContinuationStore;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly limits: ToolLimits;
  readonly signal: AbortSignal;
  readonly search: SearchBackend | undefined;
  readonly todos: readonly TodoItem[];
  readonly runSubagent: SubagentRunner | undefined;
}

export type DispatchOutcome =
  | {
      readonly kind: 'executed';
      readonly result: ToolResult;
      readonly emissions: readonly ToolEmission[];
    }
  | {
      readonly kind: 'denied';
      readonly source: 'gate' | 'hook';
      readonly reason: string;
      /** True when the turn must end rather than the agent adapting. */
      readonly abort: boolean;
    };

/**
 * Validate, authorize, execute, truncate.
 *
 * Returns a `denied` outcome rather than throwing, because a denial is a normal
 * event that the model should see and adapt to — not an error condition. The turn
 * machine turns it into a `tool.denied` event and a tool message.
 */
export async function dispatchToolCall(
  request: DispatchRequest,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const tool = deps.registry.get(request.name);
  if (tool === undefined) {
    // Not a permission failure: the model reached for something that does not
    // exist, and the useful response is the list of things that do.
    return {
      kind: 'executed',
      result: errorResult(
        request.callId,
        `unknown tool '${request.name}'. Available tools: ${deps.registry.names().join(', ')}.`,
      ),
      emissions: [],
    };
  }

  const hookOutcome = await deps.hooks.fireToolPre({
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    callId: request.callId,
    name: request.name,
    arguments: request.arguments,
  });

  if (hookOutcome.kind === 'deny') {
    return { kind: 'denied', source: 'hook', reason: hookOutcome.reason, abort: false };
  }

  // A rewrite goes back through the schema. A hook gets no more trust than the
  // model, so its arguments are checked by the same code.
  const effectiveArgs = hookOutcome.kind === 'rewrite' ? hookOutcome.arguments : request.arguments;

  const prepared = tool.prepare(effectiveArgs);
  if (!prepared.ok) {
    return {
      kind: 'executed',
      result: errorResult(
        request.callId,
        `invalid arguments for '${request.name}':\n${prepared.issues.join('\n')}`,
      ),
      emissions: [],
    };
  }

  const effectContext = { workspaceRoot: deps.workspaceRoot };
  let effects: readonly Effect[];
  try {
    effects = prepared.call.effects(effectContext);
  } catch (error) {
    return {
      kind: 'executed',
      result: errorResult(
        request.callId,
        `could not determine what '${request.name}' would do: ${message(error)}`,
      ),
      emissions: [],
    };
  }

  const authorization = await deps.gate.authorize({
    callId: request.callId,
    toolName: request.name,
    effects,
    summary: summarize(request.name, effects),
  });

  if (authorization.outcome === 'deny') {
    return {
      kind: 'denied',
      source: 'gate',
      reason: authorization.reason,
      abort: authorization.abort,
    };
  }

  const context: ToolContext = {
    workspaceRoot: deps.workspaceRoot,
    grant: authorization.grant,
    signal: deps.signal,
    limits: deps.limits,
    search: deps.search,
    todos: deps.todos,
    runSubagent: deps.runSubagent,
    continuations: resolverFor(deps.continuations),
  };

  const startedAt = Date.now();
  let raw: Awaited<ReturnType<typeof prepared.call.execute>>;
  try {
    raw = await prepared.call.execute(context);
  } catch (error) {
    // A `PermissionError` means the tool acted outside what it declared. That is a
    // bug in the tool rather than a user decision, and it is reported as a failed
    // call so the turn survives and the trajectory records it.
    const detail =
      error instanceof PermissionError
        ? `${error.message}. This is a bug in the '${request.name}' tool.`
        : `'${request.name}' failed: ${message(error)}`;
    return {
      kind: 'executed',
      result: { ...errorResult(request.callId, detail), durationMs: Date.now() - startedAt },
      emissions: [],
    };
  }

  const truncated = truncateContent(raw.content, {
    maxBytes: deps.limits.maxResultBytes,
    bias: 'both',
  });

  // A token is only issued when the engine actually holds the rest. Handing out a
  // token for output nobody kept costs the model a step to discover.
  const continuation =
    truncated.truncation !== undefined && raw.continuable !== undefined
      ? deps.continuations.register(raw.continuable.label, raw.continuable.text)
      : undefined;

  const result: ToolResult = {
    callId: request.callId,
    ok: raw.ok,
    content: [...truncated.content],
    truncated: truncated.truncation !== undefined,
    ...(truncated.truncation === undefined
      ? {}
      : {
          truncation: {
            ...truncated.truncation,
            ...(continuation === undefined ? {} : { continuation }),
          },
        }),
    durationMs: Date.now() - startedAt,
    ...(raw.error === undefined ? {} : { error: raw.error }),
  };

  const finalResult = await deps.hooks.fireToolPost({
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    callId: request.callId,
    name: request.name,
    result,
  });

  return { kind: 'executed', result: finalResult, emissions: raw.emissions ?? [] };
}

function resolverFor(store: ContinuationStore): ContinuationResolver {
  return { resolve: (token) => store.resolve(token) };
}

function errorResult(callId: string, text: string): ToolResult {
  return {
    callId,
    ok: false,
    content: [{ type: 'text', text }],
    truncated: false,
    error: text,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One line for a human deciding in under two seconds.
 *
 * Built from declared effects rather than from arguments, so it describes what the
 * call will *do* rather than what it was asked to do — those differ exactly when it
 * matters, and the user is approving the former.
 */
function summarize(name: string, effects: readonly Effect[]): string {
  if (effects.length === 0) return `${name} (no filesystem, command, or network access)`;
  return `${name} — ${effects.map(describeEffect).join('; ')}`;
}

function describeEffect(effect: Effect): string {
  switch (effect.kind) {
    case 'command':
      return `run: ${effect.command.join(' ')}`;
    case 'file-read':
      return `read: ${effect.path}`;
    case 'file-write':
      return `write: ${effect.path}`;
    case 'network':
      return `network: ${effect.host}`;
  }
}
