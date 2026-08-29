/**
 * The model gateway seam.
 *
 * `@adze/providers` implements this against real APIs; nothing in this package
 * makes a network call, and no test in this package can (architecture invariant 5,
 * local-first). What lives here is the interface the turn machine talks to and a
 * scripted in-memory provider that makes the entire loop testable offline.
 *
 * Three commitments are encoded in the types rather than in documentation.
 *
 * **Native tool calling is required.** {@link ModelProvider.nativeToolCalling} is
 * not a hint. There is no JSON-in-a-string variant of {@link ModelStreamChunk},
 * because that transport carries a measured ~7.3% invalid-JSON rejection rate on
 * open-weight rollouts — concentrated in exactly the cheap models that matter on
 * cost — and shipping a fallback would mean shipping a path with a known 7% failure
 * rate (ADR-0004). A provider that lacks it is `degraded`, the capability reports
 * `false`, and the engine runs it without tools rather than pretending.
 *
 * **Usage is split three ways.** `inputTokens`, `cachedInputTokens`, and
 * `outputTokens` do not overlap, so a prompt's size is the sum of the first two.
 * Folding cached tokens into the input count double-counts them and makes reported
 * cost diverge from the invoice by the cache discount, which is more than 10×.
 *
 * **The cache breakpoint is explicit.** {@link ModelRequest.cachePrefixLength} tells
 * the provider how many leading messages are the frozen epoch baseline, because some
 * providers require the marker rather than inferring it. Without it the epoch design
 * would be correct and unrewarded.
 */

import type { JsonObject, ModelSelection, Usage } from '@adze/protocol';
import { makeUsage } from '@adze/protocol';
import type { PriceSheet } from './cost.js';
import type { ToolSpec } from './registry.js';
import type { ConversationMessage } from './types.js';

export interface ModelRequest {
  readonly model: ModelSelection;
  readonly messages: readonly ConversationMessage[];
  readonly tools: readonly ToolSpec[];
  readonly signal: AbortSignal;
  /** Leading messages that form the byte-stable, cacheable prefix. */
  readonly cachePrefixLength: number;
}

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error';

export type ModelStreamChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | {
      readonly type: 'finish';
      readonly finishReason: FinishReason;
      readonly usage: Usage;
      /** Set when `finishReason` is `error`. */
      readonly message?: string;
    };

export interface ModelProvider {
  readonly name: string;
  /**
   * False means `degraded`. The engine reports it as a capability and a warning and
   * runs the model without tools; it does not fall back to asking for JSON in a
   * string.
   */
  readonly nativeToolCalling: boolean;
  /**
   * Prices for a model, or `undefined` when unknown.
   *
   * `undefined` is a real answer and is treated as one: a `maxSpendUsd` budget
   * against an unpriced model is refused at submit rather than silently unenforced.
   */
  priceFor(model: ModelSelection): PriceSheet | undefined;
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk>;
}

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

export interface ScriptedToolCall {
  readonly name: string;
  readonly arguments: JsonObject;
  /** Defaults to a deterministic `call_<step>_<index>`. */
  readonly callId?: string;
}

export interface ScriptedStep {
  /** Emitted as a single delta. Use `textDeltas` to exercise chunking. */
  readonly text?: string;
  readonly textDeltas?: readonly string[];
  readonly toolCalls?: readonly ScriptedToolCall[];
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly finishReason?: FinishReason;
  /** Throw instead of streaming, to exercise the error path. */
  readonly throws?: string;
  /** Delay before the first chunk, to exercise cancellation and wall-clock budgets. */
  readonly delayMs?: number;
}

export interface ScriptedProviderOptions {
  readonly script: readonly ScriptedStep[] | ScriptedStepFn;
  readonly name?: string;
  readonly nativeToolCalling?: boolean;
  readonly prices?: PriceSheet;
  /** Default per-step usage when a step does not state its own. */
  readonly defaultUsage?: Pick<ScriptedStep, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>;
}

export interface ScriptedStepContext {
  readonly step: number;
  readonly messages: readonly ConversationMessage[];
}

export type ScriptedStepFn = (context: ScriptedStepContext) => ScriptedStep;

/** A request as the provider received it, retained for assertions. */
export interface RecordedRequest {
  readonly step: number;
  readonly model: string;
  readonly cachePrefixLength: number;
  readonly toolNames: readonly string[];
  readonly messageCount: number;
  /**
   * The cacheable prefix, serialized.
   *
   * Retained as a string on purpose: the claim the epoch design makes is about
   * bytes, and comparing two strings is the only assertion that actually tests it.
   * Comparing object graphs would pass for a prefix that had been rebuilt with a new
   * timestamp in a field the comparison ignored.
   */
  readonly prefix: string;
  readonly messages: readonly ConversationMessage[];
}

/**
 * An in-memory provider driven by a script.
 *
 * Makes the whole turn machine testable with zero network and zero cost, which is
 * the only reason the loop's budget, cancellation, and gate behaviour can be
 * regression-tested on every pull request rather than by hand.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name: string;
  readonly nativeToolCalling: boolean;
  /** Every request, in order. */
  readonly requests: RecordedRequest[] = [];
  private step = 0;
  private readonly script: readonly ScriptedStep[] | ScriptedStepFn;
  private readonly prices: PriceSheet | undefined;
  private readonly defaultUsage: Required<
    Pick<ScriptedStep, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>
  >;

  constructor(options: ScriptedProviderOptions) {
    this.name = options.name ?? 'scripted';
    this.nativeToolCalling = options.nativeToolCalling ?? true;
    this.script = options.script;
    this.prices = options.prices;
    this.defaultUsage = {
      inputTokens: options.defaultUsage?.inputTokens ?? 100,
      cachedInputTokens: options.defaultUsage?.cachedInputTokens ?? 0,
      outputTokens: options.defaultUsage?.outputTokens ?? 20,
    };
  }

  priceFor(): PriceSheet | undefined {
    return this.prices;
  }

  /** Model round-trips served so far. */
  get callCount(): number {
    return this.step;
  }

  /** The serialized prefix of every request. Byte-comparison, not deep equality. */
  prefixes(): readonly string[] {
    return this.requests.map((request) => request.prefix);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const step = this.step;
    this.step += 1;

    this.requests.push({
      step,
      model: request.model.model,
      cachePrefixLength: request.cachePrefixLength,
      toolNames: request.tools.map((tool) => tool.name),
      messageCount: request.messages.length,
      prefix: JSON.stringify(request.messages.slice(0, request.cachePrefixLength)),
      messages: [...request.messages],
    });

    const scripted = this.stepFor(step, request.messages);

    if (scripted.delayMs !== undefined && scripted.delayMs > 0) {
      await sleep(scripted.delayMs, request.signal);
    }
    if (request.signal.aborted) return;

    if (scripted.throws !== undefined) throw new Error(scripted.throws);

    for (const delta of scripted.textDeltas ??
      (scripted.text === undefined ? [] : [scripted.text])) {
      if (request.signal.aborted) return;
      yield { type: 'text-delta', text: delta };
    }

    const calls = scripted.toolCalls ?? [];
    for (const [index, call] of calls.entries()) {
      if (request.signal.aborted) return;
      yield {
        type: 'tool-call',
        callId: call.callId ?? `call_${step}_${index}`,
        name: call.name,
        arguments: call.arguments,
      };
    }

    yield {
      type: 'finish',
      finishReason: scripted.finishReason ?? (calls.length > 0 ? 'tool-calls' : 'stop'),
      usage: makeUsage({
        inputTokens: scripted.inputTokens ?? this.defaultUsage.inputTokens,
        cachedInputTokens: scripted.cachedInputTokens ?? this.defaultUsage.cachedInputTokens,
        outputTokens: scripted.outputTokens ?? this.defaultUsage.outputTokens,
      }),
    };
  }

  /**
   * The step to play.
   *
   * A script that runs out yields a plain stop rather than throwing. Otherwise every
   * test would have to pad its script to cover a loop that ran one step longer than
   * expected, and the failure would look like a provider error instead of a loop
   * that did not terminate when it should have.
   */
  private stepFor(step: number, messages: readonly ConversationMessage[]): ScriptedStep {
    if (typeof this.script === 'function') return this.script({ step, messages });
    return this.script[step] ?? { text: '' };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * A provider that fails before it streams anything.
 *
 * For asserting the loop's error path. Throws synchronously rather than from inside a
 * generator, which models the common real failure — no credentials, no route to host,
 * a rejected request — where nothing was ever streamed. A failure *during* a stream is
 * a different path and is covered by {@link ScriptedStep.throws}.
 */
export class FailingProvider implements ModelProvider {
  readonly name = 'failing';
  readonly nativeToolCalling = true;

  constructor(private readonly message = 'provider unavailable') {}

  priceFor(): PriceSheet | undefined {
    return undefined;
  }

  stream(): AsyncIterable<ModelStreamChunk> {
    throw new Error(this.message);
  }
}
