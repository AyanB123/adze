/**
 * The model gateway.
 *
 * One {@link ModelProvider} that routes on `ModelSelection.provider`, so a session can
 * name `anthropic/claude-sonnet-4-5` or `openrouter/meta-llama/llama-3.1-70b-instruct`
 * and the engine does not have to know which is which. Core's seam takes a single
 * provider instance, and a router is the shape that satisfies it without making the CLI
 * rebuild the engine to change model.
 *
 * ### Native tool calling, and no fallback
 *
 * Tools cross as JSON Schema through the SDK's native tool-calling path and come back
 * as parsed `tool-call` parts. There is no branch anywhere in this package that asks a
 * model to emit JSON in a string: ADR-0004 measured that transport at a 7.3%
 * invalid-JSON rejection rate on open-weight rollouts, concentrated in exactly the cheap
 * models an open-source tool competes on, and a code path with a known 7% failure rate
 * is worse than not supporting the model.
 *
 * A model declared without native tool calling is `degraded`. The engine reads
 * {@link nativeToolCalling}, disables tools for the turn, and emits a warning every
 * surface renders. This gateway's part of that contract is to report the fact and to
 * **refuse** rather than degrade quietly if tools are requested for such a model
 * anyway.
 *
 * ### Where core's seam is coarser than the fact
 *
 * `ModelProvider.nativeToolCalling` is a property of the provider; native tool calling
 * is a property of the model. This gateway is constructed with the model the session
 * will use and reports that model's capability, which is exact in practice because the
 * CLI resolves `--model` before it builds the engine. The residual case — a per-turn
 * model override, from `turnSubmit`, onto a model with a different capability — is
 * handled in {@link stream} by refusing with a message that says what to do, rather
 * than by sending tools to a model that cannot use them. That is the one place this
 * package works around the shape of core's interface, and it is noted rather than
 * papered over.
 *
 * ### One round-trip per call
 *
 * `stopWhen: stepCountIs(1)`. The SDK can run its own tool loop; it must not. Dispatch,
 * the permission gate, truncation, hooks, and the linear history all belong to
 * `@adze/core`, and a tool the SDK executed would be a tool that never passed the gate
 * — the one invariant with no exceptions. So the tools carry no `execute` and the SDK
 * stops as soon as it has emitted the calls.
 *
 * ### Nothing leaves here unredacted
 *
 * Every message that can reach a user, a log, or a trajectory goes through the
 * redactor first. An `APICallError` carries the request URL and body, and on some
 * proxies the response headers, which is the most likely way an API key ends up in a
 * published benchmark artifact.
 */

import type {
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelStreamChunk,
  PriceSheet,
} from '@adze/core';
import type { JsonObject, ModelSelection } from '@adze/protocol';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, type LanguageModel, stepCountIs, streamText } from 'ai';
import { capabilitiesFor, type ModelCapabilities } from './catalog.js';
import type { ProviderKind, ResolvedProvider } from './config.js';
import {
  adviceFor,
  classifyStatus,
  ProviderConfigurationError,
  ProviderRequestError,
  type RequestFailureKind,
} from './errors.js';
import { toModelMessages, toToolSet } from './messages.js';
import { createRedactor, type Redactor } from './redact.js';
import { type SdkUsage, toProtocolUsage } from './usage.js';

/**
 * Builds the SDK model object for a resolved provider.
 *
 * The seam that makes this package testable with no network, no key, and no cost: a
 * test passes a factory returning `MockLanguageModelV4` and every line below runs
 * unchanged. Without it the only way to exercise the stream translation would be a live
 * request, which means the translation would be tested approximately never.
 */
export type LanguageModelFactory = (provider: ResolvedProvider, modelId: string) => LanguageModel;

export interface GatewayOptions {
  /** Every configured provider, keyed by the id used in `ModelSelection.provider`. */
  readonly providers: readonly ResolvedProvider[];
  /**
   * The model this gateway reports capabilities for.
   *
   * Required, because `nativeToolCalling` has to answer for something concrete. See the
   * file comment on where core's seam is coarser than the fact.
   */
  readonly model: ModelSelection;
  /** Override for tests. Defaults to the real SDK adapters. */
  readonly languageModel?: LanguageModelFactory;
}

/** Reasoning effort as core's protocol spells it. */
type Effort = NonNullable<ModelSelection['effort']>;

function defaultLanguageModel(provider: ResolvedProvider, modelId: string): LanguageModel {
  const headers = provider.headers === undefined ? {} : { headers: { ...provider.headers } };

  switch (provider.kind) {
    case 'anthropic':
      return createAnthropic({
        ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
        ...headers,
      })(modelId);
    case 'openai':
      return createOpenAI({
        ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
        ...headers,
      })(modelId);
    case 'openai-compatible': {
      if (provider.baseURL === undefined) {
        // Structurally required rather than defaulted. An OpenAI-compatible provider
        // with no endpoint silently falling back to api.openai.com would send a local
        // model's prompt to a vendor, which is a local-first violation the user did not
        // ask for and would not see.
        throw new ProviderConfigurationError(
          `provider '${provider.id}' is openai-compatible but has no base URL, so there is ` +
            `nowhere to send the request`,
          {
            hints: [
              `Set ${provider.id === 'openai-compatible' ? 'ADZE_COMPATIBLE_BASE_URL' : `providers.${provider.id}.baseURL`}.`,
              'For example http://localhost:11434/v1 for Ollama, or https://openrouter.ai/api/v1.',
            ],
          },
        );
      }
      return createOpenAICompatible({
        name: provider.id,
        baseURL: provider.baseURL,
        ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
        ...headers,
        // Without this an OpenAI-compatible server omits the usage block from a
        // streamed response, and a turn with no usage is a turn with no cost and an
        // unenforceable token budget.
        includeUsage: true,
      })(modelId);
    }
  }
}

/**
 * Reasoning effort, per transport.
 *
 * OpenAI takes an effort level directly. Anthropic takes a *thinking token budget*,
 * which is a different quantity — translating `high` into a number would mean inventing
 * the number, and a benchmark report that pinned "effort: high" would be describing a
 * budget Adze chose rather than a setting the user did. So Anthropic refuses instead,
 * with a message that says why. A silent drop is the same failure as an unenforced
 * budget: a knob that reports success and does nothing.
 */
function effortOptions(
  kind: ProviderKind,
  effort: Effort | undefined,
): Record<string, Record<string, string>> | undefined {
  if (effort === undefined) return undefined;
  switch (kind) {
    case 'openai':
    case 'openai-compatible':
      return { openai: { reasoningEffort: effort } };
    case 'anthropic':
      throw new ProviderConfigurationError(
        `model selection set effort '${effort}', which Anthropic does not accept: it exposes a ` +
          `thinking token budget rather than an effort level`,
        {
          hints: [
            'Omit the effort setting for Anthropic models.',
            'Translating an effort level into a token budget would mean Adze inventing the budget, which a reproducible run cannot report honestly.',
          ],
        },
      );
  }
}

/** The SDK's unified finish reason mapped onto core's. */
function toFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool-calls':
      return 'tool-calls';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content-filter';
    case 'error':
      return 'error';
    default:
      // `other` and anything an adapter adds later. Reported as a plain stop rather
      // than as an error: the model finished, and calling that an error would put a
      // successful turn in the failure bucket of every metric.
      return 'stop';
  }
}

/**
 * Turn whatever the SDK threw into a classified, redacted error.
 *
 * `APICallError` carries the status, so the classification is real rather than derived
 * from message text. A `RetryError` wraps the last attempt, so its cause is unwrapped to
 * get at the status underneath — reporting a rate limit as `unknown` because it arrived
 * inside a retry wrapper would produce advice that says "re-run once" for a limit that
 * needs concurrency lowered.
 */
function toRequestError(
  error: unknown,
  context: {
    readonly provider: ResolvedProvider;
    readonly model: string;
    readonly redact: Redactor;
  },
): ProviderRequestError {
  const { provider, model, redact } = context;
  const apiError = findApiCallError(error);

  if (apiError !== undefined) {
    const kind =
      apiError.statusCode === undefined ? 'network' : classifyStatus(apiError.statusCode);
    return new ProviderRequestError({
      message: buildMessage(kind, provider, model, redact(apiError.message)),
      kind,
      provider: provider.id,
      model,
      status: apiError.statusCode,
      retried: provider.maxRetries > 0 && apiError.isRetryable === true,
    });
  }

  const raw = error instanceof Error ? error.message : String(error);
  const kind = looksLikeNetworkFailure(raw) ? 'network' : 'unknown';
  return new ProviderRequestError({
    message: buildMessage(kind, provider, model, redact(raw)),
    kind,
    provider: provider.id,
    model,
    status: undefined,
    retried: false,
  });
}

/** Unwrap `RetryError` and any other `cause` chain to find the HTTP failure. */
function findApiCallError(error: unknown): APICallError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (APICallError.isInstance(current)) return current;
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      // RetryError keeps every attempt. The last one is the one that ended it.
      for (const attempt of [...errors].reverse()) {
        if (APICallError.isInstance(attempt)) return attempt;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const NETWORK_HINTS = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'fetch failed',
];

function looksLikeNetworkFailure(message: string): boolean {
  return NETWORK_HINTS.some((hint) => message.includes(hint));
}

/**
 * Compose the message a surface prints.
 *
 * Advice is attached here rather than left to the CLI so every surface says the same
 * thing about the same failure, and so the message is complete when it reaches a log
 * that has no CLI attached.
 */
function buildMessage(
  kind: RequestFailureKind,
  provider: ResolvedProvider,
  model: string,
  detail: string,
): string {
  const advice = adviceFor(kind, provider.apiKeyEnvCandidates);
  return [`${provider.id}/${model}: ${detail}`, ...advice.map((line) => `  ${line}`)].join('\n');
}

export class AiSdkGateway implements ModelProvider {
  readonly name: string;
  readonly nativeToolCalling: boolean;
  /** Capabilities of the model this gateway was built for. Rendered by the CLI. */
  readonly capabilities: ModelCapabilities;

  private readonly providers: ReadonlyMap<string, ResolvedProvider>;
  private readonly factory: LanguageModelFactory;
  private readonly redact: Redactor;
  /** Built lazily and reused, so an epoch's prefix hits the same client. */
  private readonly models = new Map<string, LanguageModel>();

  constructor(options: GatewayOptions) {
    this.providers = new Map(options.providers.map((provider) => [provider.id, provider]));
    this.factory = options.languageModel ?? defaultLanguageModel;
    this.redact = createRedactor(
      options.providers
        .map((provider) => provider.apiKey)
        .filter((key): key is string => key !== undefined),
    );

    const provider = this.providers.get(options.model.provider);
    this.capabilities = this.capabilitiesOf(options.model, provider);
    this.nativeToolCalling = this.capabilities.nativeToolCalling;
    this.name = `${options.model.provider} (${provider?.kind ?? 'unconfigured'})`;
  }

  /**
   * Prices, or `undefined`.
   *
   * The nullable answer is the contract: core refuses a `maxSpendUsd` budget it cannot
   * compute, and returning zero for an unpriced model would convert that refusal into a
   * spend ceiling that never fires. A model absent from `catalog.json` — which every
   * model behind a local endpoint is — has no price, and saying so is the correct
   * answer rather than a gap.
   */
  priceFor(model: ModelSelection): PriceSheet | undefined {
    return capabilitiesFor(model.provider, model.model).prices;
  }

  /** What a surface may claim about any model, not only the configured one. */
  capabilitiesFor(model: ModelSelection): ModelCapabilities {
    return this.capabilitiesOf(model, this.providers.get(model.provider));
  }

  /**
   * Capabilities, with a configured override taking precedence over the table.
   *
   * A user pointing at a local server is the authority on what that server can do; the
   * catalog has never heard of the model. `providers.<id>.nativeToolCalling: false` is
   * the only way to declare a degraded endpoint, and it has to win.
   */
  private capabilitiesOf(
    model: ModelSelection,
    provider: ResolvedProvider | undefined,
  ): ModelCapabilities {
    const base = capabilitiesFor(model.provider, model.model);
    const declared = provider?.nativeToolCalling;
    if (declared === undefined) return base;
    return { ...base, nativeToolCalling: declared, degraded: !declared };
  }

  private resolveProvider(model: ModelSelection): ResolvedProvider {
    const provider = this.providers.get(model.provider);
    if (provider === undefined) {
      throw new ProviderConfigurationError(
        `no provider is configured with the id '${model.provider}'`,
        {
          hints: [
            'Run `adze models` for the configured providers.',
            `Add it to .adze/providers.json as { "providers": { "${model.provider}": { "kind": "openai-compatible", "baseURL": "..." } } }.`,
          ],
        },
      );
    }
    return provider;
  }

  /**
   * Refuse a request that cannot be authenticated, before it is attempted.
   *
   * Named variables and no stack trace. A first run with no key is the most common
   * first experience of this tool, and `AI_LoadAPIKeyError` from three layers down is
   * the least useful possible version of it.
   *
   * A compatible endpoint may legitimately need no key — a local llama.cpp server takes
   * none — so the check is skipped there rather than inventing a requirement.
   */
  private assertCredential(provider: ResolvedProvider, model: string): void {
    if (provider.apiKey !== undefined) return;
    if (provider.kind === 'openai-compatible') return;

    const vars = provider.apiKeyEnvCandidates;
    throw new ProviderConfigurationError(
      `no API key is configured for provider '${provider.id}', so '${model}' cannot be reached`,
      {
        envVars: vars,
        hints: [
          `Set ${vars[0] ?? 'the provider API key'} in your environment.`,
          `PowerShell:  $env:${vars[0] ?? 'API_KEY'} = "..."`,
          `bash/zsh:    export ${vars[0] ?? 'API_KEY'}="..."`,
          `Or name the variable in .adze/providers.json as providers.${provider.id}.apiKeyEnv.`,
          'Adze never sends anything anywhere without a provider you configured (ADR-0001).',
        ],
      },
    );
  }

  /**
   * One model round-trip, streamed.
   *
   * Errors are raised as exceptions before anything is yielded and translated into a
   * `finish` chunk once something has been. That split matters: core discards a step
   * whose stream threw, so throwing after tool calls were emitted would lose calls the
   * model completed, while yielding a `finish` keeps the assistant message and lets the
   * loop run what it received. Each of those calls still passes the gate, so nothing is
   * loosened by keeping them.
   */
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const { model } = request;
    const provider = this.resolveProvider(model);
    this.assertCredential(provider, model.model);

    const capabilities = this.capabilitiesOf(model, provider);
    if (!capabilities.nativeToolCalling && request.tools.length > 0) {
      // Refuse rather than silently drop the tools. ADR-0004 ships no JSON-in-a-string
      // fallback, and sending tools to a model that cannot use them produces a turn
      // that looks like model incompetence rather than a configuration problem.
      throw new ProviderConfigurationError(
        `'${model.provider}/${model.model}' is configured without native tool calling, but ` +
          `${request.tools.length} tool(s) were sent`,
        {
          hints: [
            'Select this model when the engine starts, so the turn machine can disable tools for it and report the degradation.',
            'Adze ships no JSON-in-a-string fallback: that transport carries a measured ~7% invalid-JSON rejection rate (ADR-0004).',
          ],
        },
      );
    }

    const effort = effortOptions(provider.kind, model.effort);
    const result = streamText({
      model: this.languageModelFor(provider, model.model),
      // One round-trip. The loop is core's.
      stopWhen: stepCountIs(1),
      // Core's assembler puts the frozen baseline in message 0 as a system message, and
      // that position is what `cachePrefixLength` is measured against. Hoisting it into
      // `instructions` would renumber the array the cache breakpoint indexes into.
      allowSystemInMessages: true,
      messages: toModelMessages(request.messages, request.cachePrefixLength),
      tools: toToolSet(request.tools),
      abortSignal: request.signal,
      // The SDK's own exponential backoff, driven by `APICallError.isRetryable`, so
      // 429 and 5xx retry and 401 does not. Reimplementing that classification here
      // would mean maintaining a second, worse copy of it.
      maxRetries: provider.maxRetries,
      ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
      ...(effort === undefined ? {} : { providerOptions: effort }),
      // Errors arrive as an `error` part on `fullStream` as well. This handler exists
      // so the SDK does not also surface them as an unhandled rejection on one of the
      // result promises this code never awaits, which would kill the process.
      onError: () => undefined,
    });

    let emitted = false;
    let usage: SdkUsage | undefined;
    let finishReason: FinishReason = 'stop';
    let failure: unknown;

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          if (part.text.length > 0) {
            emitted = true;
            yield { type: 'text-delta', text: part.text };
          }
          break;
        case 'tool-call':
          emitted = true;
          yield {
            type: 'tool-call',
            callId: part.toolCallId,
            name: part.toolName,
            // Native tool calling: already-parsed arguments, not a string to re-parse.
            arguments: (part.input ?? {}) as JsonObject,
          };
          break;
        case 'finish':
          usage = part.totalUsage;
          finishReason = toFinishReason(part.finishReason);
          break;
        case 'error':
          failure = part.error;
          break;
        case 'abort':
          // Cancelled. Yield nothing further and append nothing: core checks the signal
          // and records the cancellation, and an assistant message with unanswered tool
          // calls is a history most providers reject.
          return;
        default:
          // reasoning, sources, files, step boundaries, raw chunks. Not part of the
          // engine's vocabulary; ignored rather than guessed at.
          break;
      }
    }

    if (request.signal.aborted) return;

    if (failure !== undefined) {
      const error = toRequestError(failure, {
        provider,
        model: model.model,
        redact: this.redact,
      });
      if (!emitted) throw error;
      yield {
        type: 'finish',
        finishReason: 'error',
        usage: toProtocolUsage(usage),
        message: error.message,
      };
      return;
    }

    yield { type: 'finish', finishReason, usage: toProtocolUsage(usage) };
  }

  private languageModelFor(provider: ResolvedProvider, modelId: string): LanguageModel {
    const key = `${provider.id}\u0000${modelId}`;
    const existing = this.models.get(key);
    if (existing !== undefined) return existing;
    const built = this.factory(provider, modelId);
    this.models.set(key, built);
    return built;
  }
}
