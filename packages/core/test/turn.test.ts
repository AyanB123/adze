import type { SandboxConfig, TurnBudget } from '@adze/protocol';
import { toolResultTruncationIsConsistent } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NullBroker, type SandboxBroker } from '../src/broker.js';
import { ContextAssembler } from '../src/context.js';
import type { PriceSheet } from '../src/cost.js';
import { EventLog, TurnEmitter } from '../src/events.js';
import { MemoryFileSystem } from '../src/fs.js';
import { HookBus, type RegisteredHook } from '../src/hooks.js';
import { sequentialIdFactory } from '../src/ids.js';
import { PermissionGate } from '../src/permissions.js';
import {
  FailingProvider,
  type ModelProvider,
  ScriptedProvider,
  type ScriptedStep,
  type ScriptedStepFn,
} from '../src/provider.js';
import { defineTool, ToolRegistry } from '../src/registry.js';
import { Session } from '../src/session.js';
import { builtinTools } from '../src/tools/index.js';
import { ContinuationStore } from '../src/truncate.js';
import { runTurn, TurnConfigurationError, type TurnOutcome } from '../src/turn.js';

const ROOT = '/work/repo';

const PRICES: PriceSheet = {
  currency: 'USD',
  inputPerMTok: 3,
  cachedInputPerMTok: 0.3,
  outputPerMTok: 15,
};

function sandbox(over: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    mode: 'workspace-write',
    writableRoots: [],
    allowedNetworkHosts: [],
    commandRules: [],
    ...over,
  };
}

interface SetupOptions {
  readonly script: readonly ScriptedStep[] | ScriptedStepFn;
  readonly budget?: TurnBudget;
  readonly hooks?: readonly RegisteredHook[];
  readonly prices?: PriceSheet;
  readonly provider?: ModelProvider;
  readonly broker?: SandboxBroker;
  readonly nativeToolCalling?: boolean;
  readonly sandbox?: SandboxConfig;
  readonly approvals?: 'untrusted' | 'on-request' | 'never';
  readonly files?: Readonly<Record<string, string>>;
  readonly tools?: readonly Parameters<ToolRegistry['register']>[0][];
  readonly clock?: { now(): number };
}

interface Harness {
  readonly session: Session;
  readonly log: EventLog;
  readonly provider: ScriptedProvider;
  readonly assembler: ContextAssembler;
  readonly controller: AbortController;
  run(): Promise<TurnOutcome>;
}

function setup(options: SetupOptions): Harness {
  const nextId = sequentialIdFactory();
  const fs = new MemoryFileSystem(options.files ?? {});
  fs.seedDirectory(ROOT);
  const log = new EventLog();
  const provider = new ScriptedProvider({
    script: options.script,
    ...(options.prices === undefined ? {} : { prices: options.prices }),
    ...(options.nativeToolCalling === undefined
      ? {}
      : { nativeToolCalling: options.nativeToolCalling }),
  });
  const effectiveProvider = options.provider ?? provider;

  const session = new Session({
    id: 'sess_1',
    workspaceRoot: ROOT,
    model: { provider: 'scripted', model: 'mock-2026-08-29' },
    sandbox: options.sandbox ?? sandbox(),
    approvals: options.approvals ?? 'on-request',
  });

  const registry = new ToolRegistry(options.tools ?? builtinTools({ nextId }));
  const gate = new PermissionGate({
    workspaceRoot: ROOT,
    sandbox: session.sandbox,
    approvals: session.approvals,
    broker: options.broker ?? new NullBroker(),
    fs,
    nextRequestId: () => nextId('appr'),
    platform: 'linux',
  });
  const assembler = new ContextAssembler({
    model: session.model.model,
    workspaceRoot: ROOT,
    sandboxMode: session.sandbox.mode,
    approvals: session.approvals,
    enforcement: gate.enforcement(),
    toolNames: registry.names(),
  });
  const hooks = new HookBus();
  for (const hook of options.hooks ?? []) hooks.register(hook);
  const controller = new AbortController();

  return {
    session,
    log,
    provider,
    assembler,
    controller,
    run: async () =>
      await runTurn(
        {
          session,
          turnId: 'turn_1',
          prompt: 'do the thing',
          attachments: [],
          budget: options.budget ?? {},
          emitter: new TurnEmitter(log.sink, session.id, 'turn_1'),
          signal: controller.signal,
        },
        {
          provider: effectiveProvider,
          registry,
          gate,
          hooks,
          assembler,
          continuations: new ContinuationStore(() => nextId('cont')),
          limits: { maxResultBytes: 4096, timeoutMs: 1000 },
          search: undefined,
          runSubagent: undefined,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        },
      ),
  };
}

describe('runTurn — a multi-step turn reaches completion', () => {
  it('drives scripted tool calls to an end-turn stop', async () => {
    const harness = setup({
      files: { [`${ROOT}/a.ts`]: 'const a = 1;\n' },
      script: [
        { text: 'Reading.', toolCalls: [{ name: 'read', arguments: { path: 'a.ts' } }] },
        {
          text: 'Editing.',
          toolCalls: [
            {
              name: 'edit',
              arguments: {
                path: 'a.ts',
                edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }],
              },
            },
          ],
        },
        { text: 'Done.' },
      ],
    });

    const outcome = await harness.run();

    expect(outcome.stopReason).toBe('end-turn');
    expect(outcome.steps).toBe(3);
    expect(outcome.text).toBe('Reading.Editing.Done.');
    expect(harness.provider.callCount).toBe(3);

    const types = harness.log.all().map((event) => event.type);
    expect(types[0]).toBe('turn.started');
    expect(types.at(-1)).toBe('turn.completed');
    expect(types).toContain('tool.started');
    expect(types).toContain('tool.finished');
    expect(types).toContain('edit.applied');
    expect(harness.log.sequenceIsContiguous()).toBe(true);
  });

  it('reports usage and a cache hit rate derived from the split', async () => {
    const harness = setup({
      script: [{ text: 'a', inputTokens: 100, cachedInputTokens: 900, outputTokens: 10 }],
    });
    const outcome = await harness.run();
    expect(outcome.usage.inputTokens).toBe(100);
    expect(outcome.usage.cachedInputTokens).toBe(900);
    expect(outcome.usage.cacheHitRate).toBeCloseTo(0.9, 10);
  });

  it('accumulates usage across steps and recomputes the rate rather than averaging', async () => {
    const harness = setup({
      script: [
        {
          toolCalls: [{ name: 'todo', arguments: { items: [] } }],
          inputTokens: 40,
          cachedInputTokens: 0,
          outputTokens: 5,
        },
        { text: 'ok', inputTokens: 100, cachedInputTokens: 39_900, outputTokens: 5 },
      ],
    });
    const outcome = await harness.run();
    // A naive average of 0 and 0.9975 would be ~0.499. Weighted by tokens it is
    // 39900 / 40040.
    expect(outcome.usage.cacheHitRate).toBeCloseTo(39_900 / 40_040, 10);
  });

  it('surfaces a provider failure as an error stop rather than throwing', async () => {
    const harness = setup({ script: [], provider: new FailingProvider('no route to host') });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('error');
    expect(outcome.message).toContain('no route to host');
  });

  it('surfaces a failure that happens mid-stream', async () => {
    // A different path from a provider that never started: the request was recorded and
    // partial output may already have reached the surface.
    const harness = setup({ script: [{ text: 'starting', throws: 'connection reset' }] });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('error');
    expect(outcome.message).toContain('connection reset');
    expect(harness.provider.requests).toHaveLength(1);
  });

  it('runs without tools when the provider lacks native tool calling', async () => {
    const harness = setup({ script: [{ text: 'text only' }], nativeToolCalling: false });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('end-turn');
    expect(harness.provider.requests[0]?.toolNames).toEqual([]);
    const started = harness.log.ofType('turn.started')[0];
    expect(started?.warnings.map((w) => w.code)).toContain('degraded-provider');
  });
});

describe('runTurn — every budget terminates the loop', () => {
  it('maxSteps stops with max-steps', async () => {
    const harness = setup({
      budget: { maxSteps: 2 },
      script: () => ({ toolCalls: [{ name: 'todo', arguments: { items: [] } }] }),
    });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('max-steps');
    expect(outcome.steps).toBe(2);
    expect(harness.provider.callCount).toBe(2);
  });

  it('maxSteps of 1 still runs the tools that step asked for', async () => {
    // A step is a model round-trip plus its tool calls. Cutting the tools off would
    // leave an assistant message with unanswered calls, which most providers reject
    // and which cannot be replayed.
    const harness = setup({
      budget: { maxSteps: 1 },
      script: [{ toolCalls: [{ name: 'todo', arguments: { items: [] } }] }],
    });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('max-steps');
    expect(harness.session.historyIsLinear()).toBe(true);
    expect(harness.log.ofType('tool.finished')).toHaveLength(1);
  });

  it('maxTokens stops with budget-exhausted', async () => {
    const harness = setup({
      budget: { maxTokens: 500 },
      script: () => ({
        toolCalls: [{ name: 'todo', arguments: { items: [] } }],
        inputTokens: 200,
        outputTokens: 100,
      }),
    });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('budget-exhausted');
    expect(outcome.message).toContain('token budget exhausted');
  });

  it('maxWallClockMs stops with budget-exhausted', async () => {
    let now = 1_000;
    const harness = setup({
      budget: { maxWallClockMs: 50 },
      clock: { now: () => now },
      script: () => {
        now += 30;
        return { toolCalls: [{ name: 'todo', arguments: { items: [] } }] };
      },
    });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('budget-exhausted');
    expect(outcome.message).toContain('wall-clock budget exhausted');
  });

  it('clamps a tool call timeout to the wall clock the turn has left', async () => {
    // Found driving a real model: `--max-time 15` produced a 98.7-second run, because
    // the wall-clock ceiling was only consulted *between* steps. A single tool call —
    // a hanging command, a test suite that never returns — ran to its own unrelated
    // tool timeout and blew straight through the turn budget. `budget.ts` states the
    // rule this violates: an unenforced budget is a suggestion.
    //
    // `BudgetTracker.remainingWallClockMs()` was written for exactly this and was never
    // called from anywhere, which is why the omission was invisible.
    let now = 0;
    const seen: number[] = [];
    const probe = defineTool({
      name: 'probe',
      description: 'records the limits it was dispatched with',
      schema: z.object({}),
      effects: () => [],
      execute: async (_args, ctx) => {
        seen.push(ctx.limits.timeoutMs);
        return await Promise.resolve({ ok: true, content: [{ type: 'text', text: 'ok' }] });
      },
    });

    const harness = setup({
      budget: { maxWallClockMs: 5_000 },
      clock: { now: () => now },
      tools: [probe],
      script: ({ step }) => {
        if (step > 0) return { text: 'done' };
        // 4 800 ms of the turn's 5 000 ms ceiling are gone before the tool runs.
        now = 4_800;
        return { toolCalls: [{ name: 'probe', arguments: {} }] };
      },
    });

    const outcome = await harness.run();

    expect(outcome.stopReason).toBe('end-turn');
    expect(seen).toHaveLength(1);
    // The harness configures a 1 000 ms per-tool ceiling, but only 200 ms of the turn
    // remain, so 200 is the honest limit to hand the tool.
    expect(seen[0]).toBe(200);
  });

  it('leaves the tool timeout alone when the turn has no wall-clock budget', async () => {
    // The clamp must not become a backdoor ceiling on an unbounded turn.
    const seen: number[] = [];
    const probe = defineTool({
      name: 'probe',
      description: 'records the limits it was dispatched with',
      schema: z.object({}),
      effects: () => [],
      execute: async (_args, ctx) => {
        seen.push(ctx.limits.timeoutMs);
        return await Promise.resolve({ ok: true, content: [{ type: 'text', text: 'ok' }] });
      },
    });

    const harness = setup({
      budget: {},
      tools: [probe],
      script: ({ step }) =>
        step > 0 ? { text: 'done' } : { toolCalls: [{ name: 'probe', arguments: {} }] },
    });

    await harness.run();
    expect(seen).toEqual([1_000]);
  });

  it('maxSpendUsd stops with budget-exhausted', async () => {
    const harness = setup({
      budget: { maxSpendUsd: 0.01 },
      prices: PRICES,
      script: () => ({
        toolCalls: [{ name: 'todo', arguments: { items: [] } }],
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('budget-exhausted');
    expect(outcome.message).toContain('spend budget exhausted');
  });

  it('refuses a spend budget it cannot compute rather than ignoring it', async () => {
    // An unenforced budget is a suggestion. Accepting a ceiling and not applying it is
    // the money-shaped version of a policy that grants more than it advertises.
    const harness = setup({ budget: { maxSpendUsd: 1 }, script: [{ text: 'hi' }] });
    await expect(harness.run()).rejects.toThrow(TurnConfigurationError);
  });

  it('reports the first exhausted ceiling in a fixed order', async () => {
    // Steps and tokens are both exhausted by the same step. The order is fixed so the
    // reported reason is stable across runs and a trajectory stays diffable.
    const harness = setup({
      budget: { maxSteps: 1, maxTokens: 1 },
      script: () => ({ toolCalls: [{ name: 'todo', arguments: { items: [] } }] }),
    });
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('max-steps');
  });
});

describe('runTurn — cancellation is clean', () => {
  it('cancelling before the first model call stops immediately', async () => {
    const harness = setup({ script: [{ text: 'never sent' }] });
    harness.controller.abort();
    const outcome = await harness.run();
    expect(outcome.stopReason).toBe('cancelled');
    expect(harness.provider.callCount).toBe(0);
  });

  it('cancelling mid-stream appends no assistant message', async () => {
    const harness = setup({
      script: [{ text: 'partial', delayMs: 5_000 }],
    });
    const running = harness.run();
    setTimeout(() => harness.controller.abort(), 10);
    const outcome = await running;

    expect(outcome.stopReason).toBe('cancelled');
    // No assistant message means no dangling tool calls, so the history is valid for
    // the next turn.
    expect(harness.session.history.some((m) => m.role === 'assistant')).toBe(false);
    expect(harness.session.historyIsLinear()).toBe(true);
  });

  it('cancelling between tool calls still completes the history', async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: 'slow',
      description: 'aborts the turn from inside itself',
      schema: z.object({}),
      effects: () => [],
      execute: async () => {
        controller.abort();
        return await Promise.resolve({ ok: true, content: [{ type: 'text', text: 'ran' }] });
      },
    });

    const nextId = sequentialIdFactory();
    const fs = new MemoryFileSystem();
    fs.seedDirectory(ROOT);
    const log = new EventLog();
    const session = new Session({
      id: 'sess_1',
      workspaceRoot: ROOT,
      model: { provider: 'scripted', model: 'mock' },
      sandbox: sandbox(),
      approvals: 'on-request',
    });
    const registry = new ToolRegistry([slow]);
    const gate = new PermissionGate({
      workspaceRoot: ROOT,
      sandbox: session.sandbox,
      approvals: session.approvals,
      broker: new NullBroker(),
      fs,
      nextRequestId: () => nextId('appr'),
      platform: 'linux',
    });

    const outcome = await runTurn(
      {
        session,
        turnId: 'turn_1',
        prompt: 'go',
        attachments: [],
        budget: {},
        emitter: new TurnEmitter(log.sink, session.id, 'turn_1'),
        signal: controller.signal,
      },
      {
        provider: new ScriptedProvider({
          script: [
            {
              toolCalls: [
                { name: 'slow', arguments: {}, callId: 'c1' },
                { name: 'slow', arguments: {}, callId: 'c2' },
                { name: 'slow', arguments: {}, callId: 'c3' },
              ],
            },
          ],
        }),
        registry,
        gate,
        hooks: new HookBus(),
        assembler: new ContextAssembler({
          model: 'mock',
          workspaceRoot: ROOT,
          sandboxMode: 'workspace-write',
          approvals: 'on-request',
          enforcement: 'gate-only',
          toolNames: registry.names(),
        }),
        continuations: new ContinuationStore(() => nextId('cont')),
        limits: { maxResultBytes: 4096, timeoutMs: 1000 },
        search: undefined,
        runSubagent: undefined,
      },
    );

    expect(outcome.stopReason).toBe('cancelled');
    // Three calls, three tool messages: the two that never ran got synthetic failures
    // so the history is not ragged.
    const toolMessages = session.history.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(session.historyIsLinear()).toBe(true);
    expect(toolMessages.slice(1).every((m) => m.role === 'tool' && !m.ok)).toBe(true);
  });
});

describe('runTurn — history is strictly linear and replayable', () => {
  it('interleaves assistant and tool messages with matching call ids', async () => {
    const harness = setup({
      script: [
        {
          toolCalls: [
            { name: 'todo', arguments: { items: [] }, callId: 'x1' },
            { name: 'todo', arguments: { items: [] }, callId: 'x2' },
          ],
        },
        { text: 'done' },
      ],
    });
    await harness.run();

    const roles = harness.session.history.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(harness.session.historyIsLinear()).toBe(true);
  });

  it('produces the same prompt when replayed through a fresh assembler', async () => {
    const harness = setup({
      script: [{ toolCalls: [{ name: 'todo', arguments: { items: [] } }] }, { text: 'done' }],
    });
    await harness.run();

    const original = harness.assembler.assemble(harness.session.history);
    const replayed = new ContextAssembler(harness.assembler.current.inputs).assemble(
      harness.session.snapshot().history,
    );

    // The trajectory is the prompt: a snapshot plus the same structural inputs
    // reproduces the request byte for byte.
    expect(JSON.stringify(replayed.messages)).toBe(JSON.stringify(original.messages));
  });

  it('holds nothing outside history — every message is JSON round-trippable', async () => {
    const harness = setup({
      script: [{ toolCalls: [{ name: 'todo', arguments: { items: [] } }] }, { text: 'x' }],
    });
    await harness.run();
    const json = JSON.stringify(harness.session.history);
    expect(JSON.parse(json)).toEqual(harness.session.history);
  });

  it('records provenance on every message', async () => {
    const harness = setup({
      hooks: [{ name: 'ctx', turnStart: () => ({ inject: [{ type: 'text', text: 'note' }] }) }],
      script: [{ text: 'ok' }],
    });
    await harness.run();
    expect(harness.session.history.map((m) => m.origin)).toEqual(['hook', 'user', 'model']);
  });
});

describe('runTurn — tool results satisfy the protocol contract', () => {
  it('keeps truncated and truncation consistent', async () => {
    const harness = setup({
      files: { [`${ROOT}/big.txt`]: 'x'.repeat(200_000) },
      script: [{ toolCalls: [{ name: 'read', arguments: { path: 'big.txt' } }] }, { text: 'ok' }],
    });
    await harness.run();
    for (const event of harness.log.ofType('tool.finished')) {
      expect(toolResultTruncationIsConsistent(event.result)).toBe(true);
    }
  });

  it('emits a denial without a matching tool.started', async () => {
    const harness = setup({
      sandbox: sandbox({ mode: 'read-only' }),
      approvals: 'never',
      script: [
        { toolCalls: [{ name: 'write', arguments: { path: 'a.ts', content: 'x' } }] },
        { text: 'blocked' },
      ],
    });
    await harness.run();
    expect(harness.log.ofType('tool.denied')).toHaveLength(1);
    // `tool.started` means the tool actually ran, so a denial must not produce one.
    expect(harness.log.ofType('tool.started')).toHaveLength(0);
    expect(harness.log.ofType('tool.finished')).toHaveLength(0);
  });

  it('ends the turn as refused when an approval decision aborts', async () => {
    const nextId = sequentialIdFactory();
    const fs = new MemoryFileSystem();
    fs.seedDirectory(ROOT);
    const log = new EventLog();
    const session = new Session({
      id: 'sess_1',
      workspaceRoot: ROOT,
      model: { provider: 'scripted', model: 'mock' },
      sandbox: sandbox({ mode: 'read-only' }),
      approvals: 'on-request',
    });
    const registry = new ToolRegistry(builtinTools({ nextId }));

    const outcome = await runTurn(
      {
        session,
        turnId: 'turn_1',
        prompt: 'go',
        attachments: [],
        budget: {},
        emitter: new TurnEmitter(log.sink, session.id, 'turn_1'),
        signal: new AbortController().signal,
      },
      {
        provider: new ScriptedProvider({
          script: [{ toolCalls: [{ name: 'write', arguments: { path: 'a.ts', content: 'x' } }] }],
        }),
        registry,
        gate: new PermissionGate({
          workspaceRoot: ROOT,
          sandbox: session.sandbox,
          approvals: session.approvals,
          broker: new NullBroker(),
          fs,
          nextRequestId: () => nextId('appr'),
          platform: 'linux',
          requestApproval: async (request) =>
            await Promise.resolve({ requestId: request.requestId, decision: 'abort' }),
        }),
        hooks: new HookBus(),
        assembler: new ContextAssembler({
          model: 'mock',
          workspaceRoot: ROOT,
          sandboxMode: 'read-only',
          approvals: 'on-request',
          enforcement: 'gate-only',
          toolNames: registry.names(),
        }),
        continuations: new ContinuationStore(() => nextId('cont')),
        limits: { maxResultBytes: 4096, timeoutMs: 1000 },
        search: undefined,
        runSubagent: undefined,
      },
    );

    // `refused` rather than `error`: the gate did its job, and collapsing the two would
    // make a working safety mechanism indistinguishable from a crash in the metrics.
    expect(outcome.stopReason).toBe('refused');
  });
});

describe('runTurn — todo state', () => {
  it('replaces the session plan with the full list', async () => {
    const harness = setup({
      script: [
        {
          toolCalls: [
            {
              name: 'todo',
              arguments: {
                items: [{ id: '1', content: 'first', status: 'in-progress' }],
              },
            },
          ],
        },
        { text: 'ok' },
      ],
    });
    await harness.run();
    expect(harness.session.todos).toEqual([{ id: '1', content: 'first', status: 'in-progress' }]);
    expect(harness.log.ofType('todo.updated')[0]?.items).toHaveLength(1);
  });
});
