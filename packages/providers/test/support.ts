/**
 * Shared offline test rig.
 *
 * Every test in this package runs against `MockLanguageModelV4` through the gateway's
 * {@link LanguageModelFactory} seam. No network, no API key, no spend — which is the only
 * reason the stream translation, the usage split, the error classification, and the
 * redaction can be regression-tested on every pull request rather than by hand against a
 * live endpoint.
 */

import type { ConversationMessage, ToolSpec } from '@adze/core';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ResolvedProvider } from '../src/config.js';

/**
 * Stream part and call-option types, inferred from the mock rather than imported.
 *
 * `@ai-sdk/provider` is a transitive dependency of `ai`, not one this package declares,
 * and adding it just to name two types would put a version in a package.json instead of
 * the workspace catalog. Inferring them from `MockLanguageModelV4` keeps the dependency
 * graph honest and cannot drift from the SDK the tests actually run against.
 */
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
export type StreamPart = StreamResult extends { stream: ReadableStream<infer P> } ? P : never;
export type CallOptions = Parameters<MockLanguageModelV4['doStream']>[0];

/** A usage record in the provider spec's shape: a prompt total plus its cache split. */
export function usage(counts: {
  total?: number;
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
}): StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: {
        total: counts.total,
        noCache: counts.noCache,
        cacheRead: counts.cacheRead,
        cacheWrite: counts.cacheWrite,
      },
      outputTokens: {
        total: counts.output,
        text: counts.output,
        reasoning: counts.reasoning,
      },
    },
  } as StreamPart;
}

export interface RecordedCall {
  readonly options: CallOptions;
}

export interface MockModel {
  readonly model: MockLanguageModelV4;
  readonly calls: RecordedCall[];
}

/**
 * A model that plays a fixed part list, recording what it was asked.
 *
 * `chunkDelayInMs` is used only by the cancellation test; everything else runs with no
 * delay so the suite stays fast and deterministic.
 */
export function mockModel(options: {
  readonly parts: readonly StreamPart[];
  readonly chunkDelayInMs?: number;
  readonly throws?: () => never;
  /** Fail this many times before playing `parts`, to exercise retry. */
  readonly failFirst?: { readonly times: number; readonly error: () => unknown };
}): MockModel {
  const calls: RecordedCall[] = [];
  let failures = 0;

  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-1',
    doStream: async (callOptions) => {
      calls.push({ options: callOptions });
      if (options.throws !== undefined) options.throws();
      if (options.failFirst !== undefined && failures < options.failFirst.times) {
        failures += 1;
        throw options.failFirst.error();
      }
      return {
        stream: simulateReadableStream({
          chunks: [{ type: 'stream-start', warnings: [] } as StreamPart, ...options.parts],
          ...(options.chunkDelayInMs === undefined
            ? {}
            : { chunkDelayInMs: options.chunkDelayInMs }),
        }),
      };
    },
  });

  return { model, calls };
}

/** A resolved provider with a credential, without touching the environment. */
export function provider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'anthropic',
    kind: 'anthropic',
    apiKey: 'sk-ant-api03-TESTTESTTESTTESTTESTTEST',
    apiKeySource: 'ANTHROPIC_API_KEY',
    apiKeyEnvCandidates: ['ANTHROPIC_API_KEY', 'ADZE_ANTHROPIC_API_KEY'],
    baseURL: undefined,
    headers: undefined,
    defaultModel: undefined,
    nativeToolCalling: undefined,
    maxRetries: 0,
    ...overrides,
  };
}

export function history(): ConversationMessage[] {
  return [
    { role: 'system', origin: 'engine', content: [{ type: 'text', text: 'baseline' }] },
    { role: 'user', origin: 'user', content: [{ type: 'text', text: 'hello' }] },
  ];
}

export const BASH_TOOL: ToolSpec = {
  name: 'bash',
  description: 'run a command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
    additionalProperties: false,
  },
};
