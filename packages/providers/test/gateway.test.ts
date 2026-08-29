import type { ModelStreamChunk } from '@adze/core';
import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { ProviderConfigurationError, ProviderRequestError } from '../src/errors.js';
import { AiSdkGateway } from '../src/gateway.js';
import { BASH_TOOL, history, mockModel, provider, usage } from './support.js';

const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;

function build(options: {
  readonly model: ReturnType<typeof mockModel>;
  readonly providers?: ReturnType<typeof provider>[];
  readonly selection?: { provider: string; model: string; effort?: 'low' | 'high' };
}): AiSdkGateway {
  return new AiSdkGateway({
    providers: options.providers ?? [provider()],
    model: options.selection ?? MODEL,
    languageModel: () => options.model.model,
  });
}

async function drain(
  stream: AsyncIterable<ModelStreamChunk>,
): Promise<readonly ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function request(overrides: Partial<Parameters<AiSdkGateway['stream']>[0]> = {}) {
  return {
    model: MODEL,
    messages: history(),
    tools: [],
    signal: new AbortController().signal,
    cachePrefixLength: 1,
    ...overrides,
  };
}

describe('streaming', () => {
  it('forwards text deltas incrementally', async () => {
    const model = mockModel({
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Hel' },
        { type: 'text-delta', id: 't', delta: 'lo' },
        { type: 'text-end', id: 't' },
        usage({ total: 100, noCache: 100, output: 5 }),
      ],
    });

    const chunks = await drain(build({ model }).stream(request()));

    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
    ]);
  });

  it('drops an empty delta rather than emitting a chunk with no content', async () => {
    const model = mockModel({
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '' },
        { type: 'text-end', id: 't' },
        usage({ total: 1, noCache: 1, output: 1 }),
      ],
    });

    const chunks = await drain(build({ model }).stream(request()));

    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(0);
  });

  it('emits a tool call with already-parsed arguments', async () => {
    // Native tool calling. There is no JSON-in-a-string path anywhere in this package:
    // ADR-0004 measured that transport at ~7.3% invalid-JSON rejections on open-weight
    // rollouts, concentrated in the cheap models that matter most on cost.
    const model = mockModel({
      parts: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'bash',
          input: JSON.stringify({ command: 'pnpm test' }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: {
            inputTokens: { total: 200, noCache: 200, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 12, text: 12, reasoning: undefined },
          },
        },
      ],
    });

    const chunks = await drain(build({ model }).stream(request({ tools: [BASH_TOOL] })));
    const call = chunks.find((chunk) => chunk.type === 'tool-call');

    expect(call).toEqual({
      type: 'tool-call',
      callId: 'call_1',
      name: 'bash',
      arguments: { command: 'pnpm test' },
    });
    expect(typeof call).toBe('object');
  });

  it('reports the finish reason the provider gave', async () => {
    const model = mockModel({
      parts: [
        {
          type: 'finish',
          finishReason: { unified: 'length', raw: 'max_tokens' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    });

    const chunks = await drain(build({ model }).stream(request()));

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'length' });
  });

  it('reports an unrecognised finish reason as a plain stop, not an error', async () => {
    // `other` means the model finished. Calling that an error would put successful turns
    // in the failure bucket of every metric.
    const model = mockModel({
      parts: [
        {
          type: 'finish',
          finishReason: { unified: 'other', raw: 'end_turn' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    });

    expect(await drain(build({ model }).stream(request()))).toEqual([
      expect.objectContaining({ type: 'finish', finishReason: 'stop' }),
    ]);
  });

  it('always ends with exactly one finish chunk', async () => {
    const model = mockModel({
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'x' },
        { type: 'text-end', id: 't' },
        usage({ total: 5, noCache: 5, output: 1 }),
      ],
    });

    const chunks = await drain(build({ model }).stream(request()));

    expect(chunks.filter((chunk) => chunk.type === 'finish')).toHaveLength(1);
    expect(chunks.at(-1)?.type).toBe('finish');
  });
});

describe('usage and cost accounting', () => {
  it('splits the prompt into disjoint input and cached-input buckets', async () => {
    const model = mockModel({
      parts: [
        usage({ total: 10_000, noCache: 1_500, cacheRead: 8_000, cacheWrite: 500, output: 40 }),
      ],
    });

    const chunks = await drain(build({ model }).stream(request()));
    const finish = chunks.at(-1);
    if (finish?.type !== 'finish') throw new Error('expected finish');

    expect(finish.usage.cachedInputTokens).toBe(8_000);
    expect(finish.usage.inputTokens).toBe(2_000);
    expect(finish.usage.cacheHitRate).toBeCloseTo(0.8, 10);
  });

  it('reports zero usage rather than failing when a provider sends none', async () => {
    const model = mockModel({
      parts: [
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: undefined,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: undefined, text: undefined, reasoning: undefined },
          },
        },
      ],
    });

    const chunks = await drain(build({ model }).stream(request()));
    const finish = chunks.at(-1);
    if (finish?.type !== 'finish') throw new Error('expected finish');

    expect(finish.usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cacheHitRate: 0,
    });
  });

  it('prices a model in the table and reports undefined for one that is not', () => {
    const gateway = build({ model: mockModel({ parts: [] }) });

    expect(gateway.priceFor(MODEL)).toBeDefined();
    // Not zero. Core refuses a spend budget it cannot compute, and a zero here would turn
    // that refusal into a ceiling that never fires.
    expect(gateway.priceFor({ provider: 'local', model: 'qwen2.5-coder' })).toBeUndefined();
  });
});

describe('the request the provider receives', () => {
  it('sends the cache breakpoint at the boundary core computed', async () => {
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });

    await drain(build({ model }).stream(request({ cachePrefixLength: 1 })));

    const prompt = model.calls[0]?.options.prompt;
    expect(prompt?.[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    expect(prompt?.[1]?.providerOptions).toBeUndefined();
  });

  it('keeps the system message in position 0 rather than hoisting it', async () => {
    // `cachePrefixLength` is an index into this array. Moving the baseline into the SDK's
    // `instructions` option would renumber it and put the marker on the wrong message.
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });

    await drain(build({ model }).stream(request()));

    expect(model.calls[0]?.options.prompt[0]?.role).toBe('system');
  });

  it('sends tools as JSON Schema function tools', async () => {
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });

    await drain(build({ model }).stream(request({ tools: [BASH_TOOL] })));

    expect(model.calls[0]?.options.tools).toEqual([
      {
        type: 'function',
        name: 'bash',
        description: 'run a command',
        inputSchema: BASH_TOOL.parameters,
      },
    ]);
  });

  it('passes temperature and max output tokens through', async () => {
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });
    const gateway = new AiSdkGateway({
      providers: [provider()],
      model: MODEL,
      languageModel: () => model.model,
    });

    await drain(
      gateway.stream(request({ model: { ...MODEL, temperature: 0.2, maxOutputTokens: 4096 } })),
    );

    expect(model.calls[0]?.options.temperature).toBe(0.2);
    expect(model.calls[0]?.options.maxOutputTokens).toBe(4096);
  });

  it('maps reasoning effort for OpenAI', async () => {
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });
    const openai = provider({ id: 'openai', kind: 'openai', apiKey: 'sk-proj-TESTTESTTESTTEST' });
    const gateway = new AiSdkGateway({
      providers: [openai],
      model: { provider: 'openai', model: 'gpt-5.4' },
      languageModel: () => model.model,
    });

    await drain(
      gateway.stream(request({ model: { provider: 'openai', model: 'gpt-5.4', effort: 'high' } })),
    );

    expect(model.calls[0]?.options.providerOptions).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  it('refuses reasoning effort for Anthropic instead of dropping it', async () => {
    // Anthropic exposes a thinking token budget, not an effort level. Translating one into
    // the other means Adze inventing the budget, and a run that reported "effort: high"
    // would be describing a setting the user never chose. A silent drop is the same
    // failure as an unenforced budget.
    const model = mockModel({ parts: [] });
    const gateway = build({ model });

    await expect(
      drain(gateway.stream(request({ model: { ...MODEL, effort: 'high' } }))),
    ).rejects.toThrow(/thinking token budget rather than an effort level/);
  });
});

describe('failures', () => {
  it('throws a classified error when the request fails before anything streams', async () => {
    const model = mockModel({
      parts: [],
      throws: () => {
        throw new APICallError({
          message: 'invalid x-api-key',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        });
      },
    });

    const error = await drain(build({ model }).stream(request())).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderRequestError);
    if (!(error instanceof ProviderRequestError)) return;
    expect(error.kind).toBe('auth');
    expect(error.status).toBe(401);
    // Names the variable rather than leaving the user to guess which one.
    expect(error.message).toContain('ANTHROPIC_API_KEY');
    expect(error.message).not.toContain('    at ');
  });

  it('distinguishes a rate limit from an exhausted balance', async () => {
    for (const [status, kind, phrase] of [
      [429, 'rate-limit', 'Rate limited'],
      [402, 'quota', 'no remaining balance'],
      [404, 'not-found', 'model id was not found'],
      [503, 'server', 'server-side failure'],
    ] as const) {
      const model = mockModel({
        parts: [],
        throws: () => {
          throw new APICallError({
            message: `upstream ${status}`,
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: status,
            isRetryable: status >= 500 || status === 429,
          });
        },
      });

      const error = await drain(build({ model }).stream(request())).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderRequestError);
      if (!(error instanceof ProviderRequestError)) continue;
      expect(error.kind).toBe(kind);
      // Waiting fixes a 429 and never fixes a 402. Advice that is wrong half the time is
      // worse than none.
      expect(error.message).toContain(phrase);
    }
  });

  it('classifies a connection refusal as a network failure', async () => {
    const model = mockModel({
      parts: [],
      throws: () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
      },
    });

    const error = await drain(build({ model }).stream(request())).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderRequestError);
    if (!(error instanceof ProviderRequestError)) return;
    expect(error.kind).toBe('network');
    expect(error.message).toContain('base URL');
  });

  it('redacts the configured key out of a provider error', async () => {
    // The likeliest way a key reaches a CI log or a published trajectory.
    const key = 'sk-ant-api03-LEAKLEAKLEAKLEAKLEAKLEAK';
    const model = mockModel({
      parts: [],
      throws: () => {
        throw new APICallError({
          message: `authentication_error: x-api-key '${key}' is not valid`,
          url: `https://api.anthropic.com/v1/messages?key=${key}`,
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        });
      },
    });

    const gateway = new AiSdkGateway({
      providers: [provider({ apiKey: key })],
      model: MODEL,
      languageModel: () => model.model,
    });

    const error = await drain(gateway.stream(request())).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).not.toContain(key);
    expect(error.message).toContain('[redacted]');
  });

  it('keeps the tool calls it received when the stream fails after emitting them', async () => {
    // Core discards a step whose stream threw, so throwing here would lose calls the model
    // completed. Reporting the error on the finish chunk keeps the assistant message
    // valid, and every one of those calls still passes the gate.
    const model = mockModel({
      parts: [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: '{"command":"ls"}' },
        { type: 'error', error: new Error('connection reset mid-stream') },
      ],
    });

    const chunks = await drain(build({ model }).stream(request({ tools: [BASH_TOOL] })));

    expect(chunks[0]).toMatchObject({ type: 'tool-call', callId: 'c1' });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' });
  });
});

describe('retry', () => {
  it('retries a retryable failure and succeeds', async () => {
    const model = mockModel({
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'recovered' },
        { type: 'text-end', id: 't' },
        usage({ total: 10, noCache: 10, output: 2 }),
      ],
      failFirst: {
        times: 1,
        error: () =>
          new APICallError({
            message: 'rate limited',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: true,
          }),
      },
    });

    const gateway = new AiSdkGateway({
      providers: [provider({ maxRetries: 2 })],
      model: MODEL,
      languageModel: () => model.model,
    });

    const chunks = await drain(gateway.stream(request()));

    expect(model.calls).toHaveLength(2);
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true);
  });

  it('does not retry a non-retryable failure', async () => {
    // 401 does not become valid by waiting. The SDK's own `isRetryable` classification is
    // what decides, rather than a second worse copy of it here.
    const model = mockModel({
      parts: [],
      throws: () => {
        throw new APICallError({
          message: 'invalid key',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        });
      },
    });

    const gateway = new AiSdkGateway({
      providers: [provider({ maxRetries: 3 })],
      model: MODEL,
      languageModel: () => model.model,
    });

    await drain(gateway.stream(request())).catch(() => undefined);

    expect(model.calls).toHaveLength(1);
  });

  it('reports the underlying status after retries are exhausted', async () => {
    const model = mockModel({
      parts: [],
      failFirst: {
        times: 99,
        error: () =>
          new APICallError({
            message: 'still rate limited',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: true,
          }),
      },
    });

    const gateway = new AiSdkGateway({
      providers: [provider({ maxRetries: 1 })],
      model: MODEL,
      languageModel: () => model.model,
    });

    const error = await drain(gateway.stream(request())).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderRequestError);
    // Unwrapped from the SDK's RetryError. Reporting this as `unknown` would produce
    // "re-run once" for a limit that needs concurrency lowered.
    if (error instanceof ProviderRequestError) expect(error.kind).toBe('rate-limit');
  });
});

describe('cancellation', () => {
  it('stops yielding and appends nothing when the signal aborts', async () => {
    const controller = new AbortController();
    const model = mockModel({
      chunkDelayInMs: 20,
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'a' },
        { type: 'text-delta', id: 't', delta: 'b' },
        { type: 'text-end', id: 't' },
        usage({ total: 10, noCache: 10, output: 2 }),
      ],
    });

    setTimeout(() => controller.abort(new Error('cancelled')), 35);
    const chunks = await drain(build({ model }).stream(request({ signal: controller.signal })));

    // No finish chunk. Core reads the signal and records the cancellation; an assistant
    // message with unanswered tool calls is a history most providers reject.
    expect(chunks.every((chunk) => chunk.type !== 'finish')).toBe(true);
  });
});

describe('configuration refusals', () => {
  it('names the environment variable when no key is configured', async () => {
    const gateway = new AiSdkGateway({
      providers: [provider({ apiKey: undefined, apiKeySource: undefined })],
      model: MODEL,
      languageModel: () => mockModel({ parts: [] }).model,
    });

    const error = await drain(gateway.stream(request())).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderConfigurationError);
    if (!(error instanceof ProviderConfigurationError)) return;
    expect(error.envVars).toContain('ANTHROPIC_API_KEY');
    expect(error.hints.join('\n')).toContain('$env:ANTHROPIC_API_KEY');
    expect(error.message).not.toContain('    at ');
  });

  it('does not require a key for a local compatible endpoint', async () => {
    // A llama.cpp server takes no key. Inventing the requirement would make the transport
    // that exists to reach local models unusable for local models.
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });
    const gateway = new AiSdkGateway({
      providers: [
        provider({
          id: 'local',
          kind: 'openai-compatible',
          apiKey: undefined,
          baseURL: 'http://localhost:11434/v1',
        }),
      ],
      model: { provider: 'local', model: 'qwen2.5-coder' },
      languageModel: () => model.model,
    });

    const chunks = await drain(
      gateway.stream(request({ model: { provider: 'local', model: 'qwen2.5-coder' } })),
    );

    expect(chunks.at(-1)?.type).toBe('finish');
  });

  it('refuses a model selection naming an unconfigured provider', async () => {
    const gateway = build({ model: mockModel({ parts: [] }) });

    const error = await drain(
      gateway.stream(request({ model: { provider: 'ghost', model: 'x' } })),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderConfigurationError);
    expect((error as Error).message).toContain("'ghost'");
  });
});

describe('degraded providers', () => {
  it('reports a declared no-tool-calling endpoint as degraded', () => {
    const gateway = new AiSdkGateway({
      providers: [
        provider({
          id: 'local',
          kind: 'openai-compatible',
          baseURL: 'http://localhost:8080/v1',
          nativeToolCalling: false,
        }),
      ],
      model: { provider: 'local', model: 'tinyllama' },
      languageModel: () => mockModel({ parts: [] }).model,
    });

    expect(gateway.nativeToolCalling).toBe(false);
    expect(gateway.capabilities.degraded).toBe(true);
  });

  it('lets a configured declaration override the catalog', () => {
    // The user is the authority on what their endpoint can do; the catalog has never heard
    // of the model.
    const gateway = new AiSdkGateway({
      providers: [provider({ nativeToolCalling: false })],
      model: MODEL,
      languageModel: () => mockModel({ parts: [] }).model,
    });

    expect(gateway.capabilitiesFor(MODEL).degraded).toBe(true);
  });

  it('refuses rather than sending tools to a model that cannot use them', async () => {
    // ADR-0004 ships no JSON-in-a-string fallback, and quietly dropping the tools would
    // produce a turn that reads as model incompetence rather than misconfiguration.
    const gateway = new AiSdkGateway({
      providers: [provider({ nativeToolCalling: false })],
      model: MODEL,
      languageModel: () => mockModel({ parts: [] }).model,
    });

    const error = await drain(gateway.stream(request({ tools: [BASH_TOOL] }))).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ProviderConfigurationError);
    expect((error as Error).message).toContain('without native tool calling');
  });

  it('runs a degraded model happily when no tools are sent', async () => {
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });
    const gateway = new AiSdkGateway({
      providers: [provider({ nativeToolCalling: false })],
      model: MODEL,
      languageModel: () => model.model,
    });

    expect((await drain(gateway.stream(request({ tools: [] })))).at(-1)?.type).toBe('finish');
  });
});

describe('identity', () => {
  it('names the provider and its transport', () => {
    expect(build({ model: mockModel({ parts: [] }) }).name).toContain('anthropic');
  });

  it('reuses one client per provider and model', async () => {
    let built = 0;
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });
    const gateway = new AiSdkGateway({
      providers: [provider()],
      model: MODEL,
      languageModel: () => {
        built += 1;
        return model.model;
      },
    });

    await drain(gateway.stream(request()));
    await drain(gateway.stream(request()));

    expect(built).toBe(1);
  });
});
