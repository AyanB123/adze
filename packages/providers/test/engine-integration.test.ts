/**
 * The gateway driven through the real engine.
 *
 * Every other test in this package checks the gateway in isolation. This one asserts the
 * thing that actually matters: that `AiSdkGateway` is substitutable for
 * `ScriptedProvider` in `@adze/core`'s own turn machine. This package is the first real
 * consumer of that seam, so a mismatch between the interface as written and the interface
 * as used would otherwise surface for the first time in a live run.
 *
 * Still no network. The model is `MockLanguageModelV4`, injected through the gateway's
 * factory seam, and the sandbox broker is core's `NullBroker`.
 */

import { Engine, EventLog, MemoryFileSystem, NullBroker, sequentialIdFactory } from '@adze/core';
import { describe, expect, it } from 'vitest';
import { AiSdkGateway } from '../src/gateway.js';
import { mockModel, provider, usage } from './support.js';

const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;
const WORKSPACE = process.platform === 'win32' ? 'C:\\work' : '/work';

function engineWith(model: ReturnType<typeof mockModel>, log: EventLog): Engine {
  return new Engine({
    provider: new AiSdkGateway({
      providers: [provider()],
      model: MODEL,
      languageModel: () => model.model,
    }),
    broker: new NullBroker(),
    sink: log.sink,
    fs: new MemoryFileSystem({ [`${WORKSPACE}`]: '' }),
    nextId: sequentialIdFactory(),
    platform: 'linux',
    defaultModel: MODEL,
  });
}

describe('a turn through the engine', () => {
  it('completes, reporting usage with the cache split intact', async () => {
    const model = mockModel({
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'All ' },
        { type: 'text-delta', id: 't', delta: 'done.' },
        { type: 'text-end', id: 't' },
        usage({ total: 5_000, noCache: 1_000, cacheRead: 4_000, output: 25 }),
      ],
    });
    const log = new EventLog();
    const engine = engineWith(model, log);

    engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });
    const { sessionId } = await engine.sessionCreate({ workspaceRoot: WORKSPACE, model: MODEL });
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'Say something.',
      attachments: [],
      budget: { maxSteps: 4 },
    });
    const outcome = await engine.awaitTurn(turnId);

    expect(outcome.stopReason).toBe('end-turn');
    expect(outcome.text).toBe('All done.');
    expect(outcome.usage.inputTokens).toBe(1_000);
    expect(outcome.usage.cachedInputTokens).toBe(4_000);
    expect(outcome.usage.cacheHitRate).toBeCloseTo(0.8, 10);
    // The engine's own sequencing guarantee, which a surface relies on to detect a
    // dropped event rather than rendering a partial turn.
    expect(log.sequenceIsContiguous()).toBe(true);
  });

  it('streams text deltas as events rather than one buffered blob', async () => {
    const model = mockModel({
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'one' },
        { type: 'text-delta', id: 't', delta: 'two' },
        { type: 'text-end', id: 't' },
        usage({ total: 10, noCache: 10, output: 2 }),
      ],
    });
    const log = new EventLog();
    const engine = engineWith(model, log);
    engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });
    const { sessionId } = await engine.sessionCreate({ workspaceRoot: WORKSPACE, model: MODEL });
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'hi',
      attachments: [],
      budget: { maxSteps: 1 },
    });
    await engine.awaitTurn(turnId);

    expect(log.ofType('text.delta').map((event) => event.text)).toEqual(['one', 'two']);
  });

  it('sends the tool catalog and the cache breakpoint core computed', async () => {
    const model = mockModel({ parts: [usage({ total: 10, noCache: 10, output: 1 })] });
    const log = new EventLog();
    const engine = engineWith(model, log);
    engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });
    const { sessionId } = await engine.sessionCreate({ workspaceRoot: WORKSPACE, model: MODEL });
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'hi',
      attachments: [],
      budget: { maxSteps: 1 },
    });
    await engine.awaitTurn(turnId);

    const options = model.calls[0]?.options;
    // Core's built-in set, advertised natively.
    expect(options?.tools?.map((tool) => tool.name)).toContain('bash');
    // The frozen baseline is message 0, and the marker landed on it.
    expect(options?.prompt[0]?.role).toBe('system');
    expect(options?.prompt[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('keeps the cacheable prefix byte-identical across steps', async () => {
    // The claim the epoch design makes, checked end to end through the real assembler and
    // the real conversion. Compared as a string, because comparing object graphs would
    // pass for a prefix rebuilt with a new timestamp in a field the comparison ignored.
    const model = mockModel({
      parts: [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'todo',
          input: JSON.stringify({ items: [{ id: '1', content: 'step', status: 'pending' }] }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    });
    const log = new EventLog();
    const engine = engineWith(model, log);
    engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });
    const { sessionId } = await engine.sessionCreate({ workspaceRoot: WORKSPACE, model: MODEL });
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'plan it',
      attachments: [],
      budget: { maxSteps: 3 },
    });
    await engine.awaitTurn(turnId);

    expect(model.calls.length).toBeGreaterThan(1);
    const prefixes = model.calls.map((call) => JSON.stringify(call.options.prompt.slice(0, 1)));
    expect(new Set(prefixes).size).toBe(1);
  });

  it('runs a tool the model asked for, through the gate', async () => {
    // `todo` declares no effects, so it is authorized without a prompt and runs under the
    // default policy — which makes it the tool that proves dispatch works without also
    // testing the approval channel.
    const model = mockModel({
      parts: [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'todo',
          input: JSON.stringify({
            items: [{ id: '1', content: 'write the report', status: 'in-progress' }],
          }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    });
    const log = new EventLog();
    const engine = engineWith(model, log);
    engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });
    const { sessionId } = await engine.sessionCreate({ workspaceRoot: WORKSPACE, model: MODEL });
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'plan it',
      attachments: [],
      // One step: a model round-trip *plus* the tool calls it produced. The step boundary
      // sits after tool execution, so this runs the tool and then stops.
      budget: { maxSteps: 1 },
    });
    await engine.awaitTurn(turnId);

    // `tool.started` is emitted only after authorization, so its presence means the tool
    // actually ran rather than that a call was attempted.
    expect(log.ofType('tool.started').map((event) => event.call.name)).toContain('todo');
    expect(log.ofType('todo.updated')).toHaveLength(1);
  });

  it('reports a provider failure as an error stop rather than crashing the turn', async () => {
    const model = mockModel({
      parts: [],
      throws: () => {
        throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443');
      },
    });
    const log = new EventLog();
    const engine = engineWith(model, log);
    engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });
    const { sessionId } = await engine.sessionCreate({ workspaceRoot: WORKSPACE, model: MODEL });
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'hi',
      attachments: [],
      budget: { maxSteps: 1 },
    });
    const outcome = await engine.awaitTurn(turnId);

    expect(outcome.stopReason).toBe('error');
    expect(outcome.message).toContain('model request failed');
    // The advice the gateway attached survives the trip through the engine.
    expect(outcome.message).toContain('base URL');
  });

  it('refuses a spend budget on an unpriced model rather than not enforcing it', async () => {
    // The gateway's `undefined` price is what makes this refusal happen. Returning zero
    // would produce a ceiling that silently never fires.
    const model = mockModel({ parts: [usage({ total: 1, noCache: 1, output: 1 })] });
    const log = new EventLog();
    const unpriced = { provider: 'local', model: 'qwen2.5-coder' } as const;
    const engine = new Engine({
      provider: new AiSdkGateway({
        providers: [
          provider({
            id: 'local',
            kind: 'openai-compatible',
            apiKey: undefined,
            baseURL: 'http://localhost:11434/v1',
          }),
        ],
        model: unpriced,
        languageModel: () => model.model,
      }),
      broker: new NullBroker(),
      sink: log.sink,
      fs: new MemoryFileSystem({ [`${WORKSPACE}`]: '' }),
      nextId: sequentialIdFactory(),
      platform: 'linux',
      defaultModel: unpriced,
    });
    engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });
    const { sessionId } = await engine.sessionCreate({
      workspaceRoot: WORKSPACE,
      model: unpriced,
    });
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'hi',
      attachments: [],
      budget: { maxSpendUsd: 1 },
    });

    await expect(engine.awaitTurn(turnId)).rejects.toThrow(/no prices for model/);
  });
});

describe('capability reporting', () => {
  it('reports native tool calling to the engine', async () => {
    const log = new EventLog();
    const engine = engineWith(mockModel({ parts: [] }), log);

    const result = engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });

    expect(result.capabilities.nativeToolCalling).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('degraded-provider');
  });

  it('makes the engine warn when the configured endpoint is degraded', async () => {
    // ADR-0004's required behaviour: a provider without native tool calling is reported,
    // and the turn runs without tools rather than through a JSON-in-a-string fallback that
    // does not exist.
    const log = new EventLog();
    const degraded = { provider: 'local', model: 'tinyllama' } as const;
    const engine = new Engine({
      provider: new AiSdkGateway({
        providers: [
          provider({
            id: 'local',
            kind: 'openai-compatible',
            apiKey: undefined,
            baseURL: 'http://localhost:8080/v1',
            nativeToolCalling: false,
          }),
        ],
        model: degraded,
        languageModel: () => mockModel({ parts: [] }).model,
      }),
      broker: new NullBroker(),
      sink: log.sink,
      fs: new MemoryFileSystem({ [`${WORKSPACE}`]: '' }),
      nextId: sequentialIdFactory(),
      platform: 'linux',
      defaultModel: degraded,
    });

    const result = engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'providers-test', version: '0.0.1', platform: 'linux' },
    });

    expect(result.capabilities.nativeToolCalling).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain('degraded-provider');
  });
});
