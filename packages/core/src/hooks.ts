/**
 * The hook bus.
 *
 * Four lifecycle points, matching ADR-0003's loop exactly: `session.turnStart`,
 * `tool.pre`, `tool.post`, `session.turnEnd`. `tool.pre` is the important one,
 * because it **can deny**. A hook that can veto a tool call lets a team encode its
 * own policy — no `rm -rf`, no writes under `infra/`, no network at all — without
 * us building a policy feature and without a fork.
 *
 * ## Timeouts fail closed on `tool.pre`, and open elsewhere
 *
 * A hook is third-party code, so it gets a hard timeout. What happens when the
 * timeout fires is a real decision rather than an implementation detail.
 *
 * On `tool.pre` a timeout **denies**. A hook that exists to veto and does not
 * answer must not be interpreted as consent: failing open there would let a flaky
 * or deliberately slow hook void the policy it was installed to enforce, silently,
 * which is worse than the agent being blocked. The cost is that a broken hook can
 * stop the agent, and that cost is the correct one to pay — a blocked agent is
 * visible and a voided policy is not.
 *
 * On `session.turnStart`, `tool.post`, and `session.turnEnd` a timeout continues.
 * Those hooks observe or enrich; none of them is a permission boundary, so a
 * missing answer costs some context rather than a guarantee.
 *
 * ## No hook may inject UI
 *
 * Architecture invariant 3. A hook returns data — content blocks, arguments, a
 * replacement result — and never anything display-shaped. UI extension happens
 * per-surface, which is what keeps the engine from acquiring an opinion about
 * rendering through the plugin system's back door.
 */

import type { ContentBlock, JsonObject, StopReason, ToolResult, Usage } from '@adze/protocol';

export interface TurnStartContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly cacheEpoch: number;
}

/**
 * Extra context a hook wants the model to see.
 *
 * It rides as an ordered mid-conversation message, never as a change to the
 * baseline system prompt: mutating the prefix would invalidate the provider cache
 * for the whole epoch, and cache economics move effective cost by more than 10×.
 */
export interface TurnStartOutcome {
  readonly inject?: readonly ContentBlock[];
}

export interface ToolPreContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export type ToolPreOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'deny'; readonly reason: string }
  /**
   * Replace the arguments.
   *
   * Rewritten arguments are re-validated against the tool's schema before anything
   * runs. A hook is third-party code and gets no more trust than the model does;
   * skipping validation here would make the hook bus a way around the one place
   * arguments are checked.
   */
  | { readonly kind: 'rewrite'; readonly arguments: JsonObject };

export interface ToolPostContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly result: ToolResult;
}

export type ToolPostOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'replace'; readonly result: ToolResult };

export interface TurnEndContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly steps: number;
}

export interface Hooks {
  turnStart?(context: TurnStartContext): Promise<TurnStartOutcome> | TurnStartOutcome;
  toolPre?(context: ToolPreContext): Promise<ToolPreOutcome> | ToolPreOutcome;
  toolPost?(context: ToolPostContext): Promise<ToolPostOutcome> | ToolPostOutcome;
  turnEnd?(context: TurnEndContext): Promise<void> | void;
}

export interface RegisteredHook extends Hooks {
  /** Appears in denial reasons, so a blocked action names what blocked it. */
  readonly name: string;
  /** Overrides the bus default. */
  readonly timeoutMs?: number;
}

export interface Disposable {
  dispose(): void;
}

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** Sentinel for "the hook did not answer in time". */
const TIMED_OUT = Symbol('adze.hook.timeout');

async function withTimeout<T>(
  work: Promise<T> | T,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<typeof TIMED_OUT>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class HookBus {
  private readonly hooks: RegisteredHook[] = [];

  constructor(private readonly defaultTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS) {}

  register(hook: RegisteredHook): Disposable {
    this.hooks.push(hook);
    return {
      dispose: () => {
        const index = this.hooks.indexOf(hook);
        if (index >= 0) this.hooks.splice(index, 1);
      },
    };
  }

  get size(): number {
    return this.hooks.length;
  }

  /** Injected context from every hook, in registration order. */
  async fireTurnStart(context: TurnStartContext): Promise<readonly ContentBlock[]> {
    const injected: ContentBlock[] = [];
    for (const hook of this.hooks) {
      if (hook.turnStart === undefined) continue;
      const outcome = await this.run(hook, () => {
        const fn = hook.turnStart;
        if (fn === undefined) return { kind: 'skip' as const };
        return { kind: 'value' as const, value: fn.call(hook, context) };
      });
      if (outcome.kind !== 'value') continue;
      injected.push(...(outcome.value.inject ?? []));
    }
    return injected;
  }

  /**
   * Run `tool.pre` across every hook.
   *
   * First denial wins and short-circuits: once one hook has said no, asking the
   * rest is pointless and gives them a chance to observe a call that will not
   * happen. Rewrites chain, so a normalizing hook and a policy hook compose.
   */
  async fireToolPre(context: ToolPreContext): Promise<ToolPreOutcome> {
    let current = context;
    let rewritten = false;

    for (const hook of this.hooks) {
      if (hook.toolPre === undefined) continue;
      const outcome = await this.run(hook, () => {
        const fn = hook.toolPre;
        if (fn === undefined) return { kind: 'skip' as const };
        return { kind: 'value' as const, value: fn.call(hook, current) };
      });

      if (outcome.kind === 'timeout') {
        // Fail closed. See the file header: an unanswered veto is not consent.
        return {
          kind: 'deny',
          reason:
            `hook '${hook.name}' did not answer within ` +
            `${hook.timeoutMs ?? this.defaultTimeoutMs} ms, and a tool.pre hook that ` +
            `cannot answer is treated as a denial rather than as approval`,
        };
      }
      if (outcome.kind === 'error') {
        return {
          kind: 'deny',
          reason: `hook '${hook.name}' failed: ${outcome.message}`,
        };
      }
      if (outcome.kind === 'skip') continue;

      const value = outcome.value;
      if (value.kind === 'deny') {
        return { kind: 'deny', reason: `hook '${hook.name}': ${value.reason}` };
      }
      if (value.kind === 'rewrite') {
        current = { ...current, arguments: value.arguments };
        rewritten = true;
      }
    }

    return rewritten ? { kind: 'rewrite', arguments: current.arguments } : { kind: 'continue' };
  }

  /** Last replacement wins. A failing or slow hook leaves the result untouched. */
  async fireToolPost(context: ToolPostContext): Promise<ToolResult> {
    let result = context.result;
    for (const hook of this.hooks) {
      if (hook.toolPost === undefined) continue;
      const outcome = await this.run(hook, () => {
        const fn = hook.toolPost;
        if (fn === undefined) return { kind: 'skip' as const };
        return { kind: 'value' as const, value: fn.call(hook, { ...context, result }) };
      });
      if (outcome.kind !== 'value') continue;
      if (outcome.value.kind === 'replace') result = outcome.value.result;
    }
    return result;
  }

  async fireTurnEnd(context: TurnEndContext): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.turnEnd === undefined) continue;
      await this.run(hook, () => {
        const fn = hook.turnEnd;
        if (fn === undefined) return { kind: 'skip' as const };
        return { kind: 'value' as const, value: Promise.resolve(fn.call(hook, context)) };
      });
    }
  }

  /**
   * Invoke one hook with a timeout, converting every failure mode into a value.
   *
   * `invoke()` is inside the `try` deliberately. A hook that throws *synchronously*
   * — the ordinary shape of a bug in a non-async handler — would otherwise escape
   * this function entirely and propagate out of `fireToolPre`, killing the turn
   * instead of producing a denial. That was a real bug caught by
   * `test/hooks.test.ts`: a policy hook with a typo would have crashed the agent
   * rather than blocking one tool call, and the crash would have looked like an
   * engine fault rather than a plugin fault.
   */
  private async run<T>(
    hook: RegisteredHook,
    invoke: () => { kind: 'skip' } | { kind: 'value'; value: Promise<T> | T },
  ): Promise<
    | { kind: 'value'; value: T }
    | { kind: 'skip' }
    | { kind: 'timeout' }
    | { kind: 'error'; message: string }
  > {
    try {
      const attempt = invoke();
      if (attempt.kind === 'skip') return { kind: 'skip' };
      const settled = await withTimeout(attempt.value, hook.timeoutMs ?? this.defaultTimeoutMs);
      if (settled === TIMED_OUT) return { kind: 'timeout' };
      return { kind: 'value', value: settled };
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }
}
