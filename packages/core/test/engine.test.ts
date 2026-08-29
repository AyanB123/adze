import type { ApprovalRequest, ApprovalResponse } from '@adze/protocol';
import { PROTOCOL_VERSION } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { NullBroker, type SandboxBroker } from '../src/broker.js';
import { Engine, type EngineOptions } from '../src/engine.js';
import { EventLog } from '../src/events.js';
import { MemoryFileSystem } from '../src/fs.js';
import { sequentialIdFactory } from '../src/ids.js';
import { ScriptedProvider, type ScriptedStep, type ScriptedStepFn } from '../src/provider.js';
import { InMemorySessionStore } from '../src/session.js';

const ROOT = '/work/repo';

/** A broker that reports real containment, to exercise the capability report. */
class ContainedBroker implements SandboxBroker {
  readonly name = 'contained';
  enforcement(): 'os-level' {
    return 'os-level';
  }
  async exec(): ReturnType<SandboxBroker['exec']> {
    return await Promise.resolve({
      kind: 'completed',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
      outputCapped: false,
      durationMs: 1,
      enforcement: 'os-level',
    });
  }
}

interface Built {
  readonly engine: Engine;
  readonly log: EventLog;
  readonly provider: ScriptedProvider;
  readonly fs: MemoryFileSystem;
}

function build(
  script: readonly ScriptedStep[] | ScriptedStepFn,
  over: Partial<EngineOptions> & { readonly files?: Readonly<Record<string, string>> } = {},
): Built {
  const log = new EventLog();
  const fs = new MemoryFileSystem(over.files ?? {});
  fs.seedDirectory(ROOT);
  const provider = new ScriptedProvider({ script });
  const engine = new Engine({
    provider: over.provider ?? provider,
    broker: over.broker ?? new NullBroker(),
    sink: log.sink,
    fs,
    store: new InMemorySessionStore(),
    nextId: sequentialIdFactory(),
    platform: 'linux',
    ...(over.search === undefined ? {} : { search: over.search }),
    ...(over.requestApproval === undefined ? {} : { requestApproval: over.requestApproval }),
    ...(over.hooks === undefined ? {} : { hooks: over.hooks }),
  });
  return { engine, log, provider, fs };
}

const CLIENT = { name: 'test-surface', version: '1.0.0', platform: 'linux' };

async function openSession(engine: Engine, over: Record<string, unknown> = {}): Promise<string> {
  const created = await engine.sessionCreate({
    workspaceRoot: ROOT,
    model: { provider: 'scripted', model: 'mock-2026-08-29' },
    ...over,
  });
  return created.sessionId;
}

describe('Engine.initialize', () => {
  it('negotiates the protocol version', () => {
    const { engine } = build([]);
    const result = engine.initialize({ protocolVersions: [PROTOCOL_VERSION], client: CLIENT });
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.engine.name).toBe('@adze/core');
  });

  it('fails loudly on an incompatible version', () => {
    const { engine } = build([]);
    expect(() => engine.initialize({ protocolVersions: ['99.0'], client: CLIENT })).toThrow(
      /protocol major version/,
    );
  });

  it('reports capabilities honestly, including the ones that are not built', () => {
    // Every false here is a roadmap item reporting itself as absent rather than being
    // quietly missing.
    const { engine } = build([]);
    const result = engine.initialize({ protocolVersions: [PROTOCOL_VERSION], client: CLIENT });
    expect(result.capabilities).toMatchObject({
      turns: true,
      edits: true,
      retrieval: false,
      nativeToolCalling: true,
      mcpClient: false,
      mcpServer: false,
      osSandbox: false,
    });
  });

  it('reports retrieval as available once a backend is configured', () => {
    const { engine } = build([], {
      search: {
        name: 'stub',
        search: async () => await Promise.resolve({ hits: [], truncated: false, notes: [] }),
        glob: async () => await Promise.resolve({ paths: [], truncated: false, notes: [] }),
        symbols: async () =>
          await Promise.resolve({ hits: [], truncated: false, extractor: 'none', notes: [] }),
      },
    });
    const result = engine.initialize({ protocolVersions: [PROTOCOL_VERSION], client: CLIENT });
    expect(result.capabilities.retrieval).toBe(true);
  });

  it('warns about missing containment at startup', () => {
    const { engine } = build([]);
    const result = engine.initialize({ protocolVersions: [PROTOCOL_VERSION], client: CLIENT });
    expect(result.warnings.map((w) => w.code)).toContain('no-os-sandbox');
  });

  it('omits the warning when the broker really contains', () => {
    const { engine } = build([], { broker: new ContainedBroker() });
    const result = engine.initialize({ protocolVersions: [PROTOCOL_VERSION], client: CLIENT });
    expect(result.capabilities.osSandbox).toBe(true);
    expect(result.warnings.map((w) => w.code)).not.toContain('no-os-sandbox');
  });

  it('warns about a provider without native tool calling', () => {
    const { engine } = build([], {
      provider: new ScriptedProvider({ script: [], nativeToolCalling: false }),
    });
    const result = engine.initialize({ protocolVersions: [PROTOCOL_VERSION], client: CLIENT });
    expect(result.capabilities.nativeToolCalling).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain('degraded-provider');
  });
});

describe('Engine.sessionCreate', () => {
  it('applies ADR-0007 defaults', async () => {
    const { engine } = build([]);
    const created = await engine.sessionCreate({ workspaceRoot: ROOT });
    expect(created.sandbox.mode).toBe('workspace-write');
    expect(created.approvals).toBe('on-request');
  });

  it('echoes what is actually in force', async () => {
    // A surface must render the real settings: showing the requested mode when the
    // engine narrowed it would be the worst possible lie in a security display.
    const { engine } = build([]);
    const created = await engine.sessionCreate({
      workspaceRoot: ROOT,
      sandbox: {
        mode: 'read-only',
        writableRoots: ['/tmp'],
        allowedNetworkHosts: [],
        commandRules: [],
      },
      approvals: 'never',
    });
    expect(created.sandbox.mode).toBe('read-only');
    expect(created.sandbox.writableRoots).toEqual(['/tmp']);
    expect(created.approvals).toBe('never');
    expect(created.warnings.map((w) => w.code)).toContain('no-os-sandbox');
  });
});

describe('Engine.turnSubmit', () => {
  it('runs a turn end to end and reports usage', async () => {
    const { engine, log } = build([
      { text: 'Looking.', toolCalls: [{ name: 'todo', arguments: { items: [] } }] },
      { text: 'Done.' },
    ]);
    engine.initialize({ protocolVersions: [PROTOCOL_VERSION], client: CLIENT });
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: { maxSteps: 5 },
    });
    const outcome = await engine.awaitTurn(turnId);

    expect(outcome.stopReason).toBe('end-turn');
    expect(outcome.steps).toBe(2);
    expect(log.ofType('turn.completed')).toHaveLength(1);
    expect(log.sequenceIsContiguous()).toBe(true);
  });

  it('accumulates session usage and turn count', async () => {
    const { engine } = build([{ text: 'one' }]);
    const sessionId = await openSession(engine);
    for (let n = 0; n < 2; n += 1) {
      const { turnId } = await engine.turnSubmit({
        sessionId,
        prompt: 'go',
        attachments: [],
        budget: {},
      });
      await engine.awaitTurn(turnId);
    }
    const closed = await engine.sessionClose({ sessionId });
    expect(closed.turns).toBe(2);
    expect(closed.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('rejects an unknown session', async () => {
    const { engine } = build([]);
    await expect(
      engine.turnSubmit({ sessionId: 'nope', prompt: 'x', attachments: [], budget: {} }),
    ).rejects.toThrow(/unknown session/);
  });

  it('refuses a second concurrent turn on the same session', async () => {
    const { engine } = build([{ text: 'slow', delayMs: 200 }]);
    const sessionId = await openSession(engine);
    const first = await engine.turnSubmit({
      sessionId,
      prompt: 'a',
      attachments: [],
      budget: {},
    });
    await expect(
      engine.turnSubmit({ sessionId, prompt: 'b', attachments: [], budget: {} }),
    ).rejects.toThrow(/already has turn/);
    engine.turnCancel({ sessionId, turnId: first.turnId });
    await engine.awaitTurn(first.turnId);
  });

  it('a per-turn permission override takes effect and rolls the epoch', async () => {
    const { engine, provider } = build([
      { toolCalls: [{ name: 'write', arguments: { path: 'a.txt', content: 'x' } }] },
      { text: 'blocked' },
    ]);
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: {},
      sandbox: {
        mode: 'read-only',
        writableRoots: [],
        allowedNetworkHosts: [],
        commandRules: [],
      },
      approvals: 'never',
    });
    await engine.awaitTurn(turnId);
    // The prefix reflects the override, so the epoch rolled rather than caching a stale
    // statement about the mode.
    expect(provider.requests[0]?.prefix).toContain('read-only');
  });
});

describe('Engine.turnCancel', () => {
  it('cancels an in-flight turn', async () => {
    const { engine } = build([{ text: 'slow', delayMs: 5_000 }]);
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: {},
    });
    expect(engine.turnCancel({ sessionId, turnId }).cancelled).toBe(true);
    const outcome = await engine.awaitTurn(turnId);
    expect(outcome.stopReason).toBe('cancelled');
  });

  it('returns false rather than erroring when the turn already finished', async () => {
    // A cancel racing a completion is normal, and making it an error would force every
    // surface to special-case a race it cannot avoid.
    const { engine } = build([{ text: 'fast' }]);
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: {},
    });
    await engine.awaitTurn(turnId);
    expect(engine.turnCancel({ sessionId, turnId }).cancelled).toBe(false);
  });

  it('returns false for an unknown session', () => {
    const { engine } = build([]);
    expect(engine.turnCancel({ sessionId: 'nope', turnId: 'nope' }).cancelled).toBe(false);
  });
});

describe('Engine — the approval channel reaches the surface', () => {
  it('routes an approval request and honours the answer', async () => {
    const seen: ApprovalRequest[] = [];
    const { engine, fs } = build(
      [
        { toolCalls: [{ name: 'write', arguments: { path: 'out.txt', content: 'hi' } }] },
        { text: 'done' },
      ],
      {
        files: {},
        requestApproval: async (request): Promise<ApprovalResponse> => {
          seen.push(request);
          return await Promise.resolve({ requestId: request.requestId, decision: 'allow-once' });
        },
      },
    );
    const sessionId = await openSession(engine, {
      sandbox: { mode: 'read-only', writableRoots: [], allowedNetworkHosts: [], commandRules: [] },
    });
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: {},
    });
    await engine.awaitTurn(turnId);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('file-write');
    expect(seen[0]?.reason).toContain('read-only');
    await expect(fs.readFile(`${ROOT}/out.txt`)).resolves.toBe('hi');
  });
});

describe('Engine — subagents', () => {
  it('runs a narrowed subagent and returns only its text', async () => {
    // A step-aware script: the parent's first step delegates, and the subagent runs its
    // own turn against the same provider.
    const { engine } = build(({ messages }) => {
      const isSubagent = messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.some((b) => b.type === 'text' && b.text.includes('find the config')),
      );
      if (isSubagent) return { text: 'config is at src/config.ts' };
      const alreadyDelegated = messages.some((message) => message.role === 'tool');
      if (alreadyDelegated) return { text: 'thanks' };
      return {
        toolCalls: [{ name: 'task', arguments: { prompt: 'find the config', tools: ['read'] } }],
      };
    });

    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'where is the config?',
      attachments: [],
      budget: { maxSteps: 6 },
    });
    const outcome = await engine.awaitTurn(turnId);

    expect(outcome.stopReason).toBe('end-turn');
    const session = await engine.session(sessionId);
    const toolMessage = session?.history.find((message) => message.role === 'tool');
    const text = toolMessage?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
    expect(text).toContain('config is at src/config.ts');
  });

  it('refuses a tool the parent does not have', async () => {
    const { engine } = build(({ messages }) => {
      const alreadyDelegated = messages.some((message) => message.role === 'tool');
      if (alreadyDelegated) return { text: 'ok' };
      return {
        toolCalls: [{ name: 'task', arguments: { prompt: 'x', tools: ['teleport'] } }],
      };
    });
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: { maxSteps: 4 },
    });
    await engine.awaitTurn(turnId);

    const session = await engine.session(sessionId);
    const toolMessage = session?.history.find((message) => message.role === 'tool');
    const text = toolMessage?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
    expect(text).toContain('unknown tool(s): teleport');
  });

  it('does not let a subagent spawn subagents', async () => {
    // Unbounded recursion through a tool call is a budget nobody set. `task` is filtered
    // out of a subagent's allowlist before narrowing, so the nested call comes back as an
    // unknown tool.
    const { engine, log } = build(({ messages }) => {
      const inSubagent = messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.some((b) => b.type === 'text' && b.text === 'nested'),
      );
      if (inSubagent) {
        return { toolCalls: [{ name: 'task', arguments: { prompt: 'deeper', tools: ['read'] } }] };
      }
      const alreadyDelegated = messages.some((message) => message.role === 'tool');
      if (alreadyDelegated) return { text: 'done' };
      return { toolCalls: [{ name: 'task', arguments: { prompt: 'nested', tools: ['read'] } }] };
    });

    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: { maxSteps: 2 },
    });
    await engine.awaitTurn(turnId);

    // Asserted on the subagent's own events: a subagent returns only its final text to
    // the parent, so the parent's history is the wrong place to look for this.
    const subagentResults = log
      .ofType('tool.finished')
      .flatMap((event) => event.result.content)
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''));
    expect(subagentResults.some((text) => text.includes("unknown tool 'task'"))).toBe(true);
  });
});

describe('Engine — hooks', () => {
  it('a registered hook can deny a tool call', async () => {
    const { engine, log } = build([
      { toolCalls: [{ name: 'write', arguments: { path: 'a.txt', content: 'x' } }] },
      { text: 'blocked' },
    ]);
    engine.registerHook({
      name: 'no-writes',
      toolPre: (ctx) =>
        ctx.name === 'write'
          ? { kind: 'deny', reason: 'writes are disabled' }
          : { kind: 'continue' },
    });
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: {},
    });
    await engine.awaitTurn(turnId);

    const denied = log.ofType('tool.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.source).toBe('hook');
    expect(denied[0]?.reason).toContain('writes are disabled');
  });

  it('a disposed hook stops firing', async () => {
    const { engine, log } = build([
      { toolCalls: [{ name: 'todo', arguments: { items: [] } }] },
      { text: 'ok' },
    ]);
    const handle = engine.registerHook({
      name: 'blocker',
      toolPre: () => ({ kind: 'deny', reason: 'no' }),
    });
    handle.dispose();
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: {},
    });
    await engine.awaitTurn(turnId);
    expect(log.ofType('tool.denied')).toHaveLength(0);
  });
});

describe('Engine — cache prefix stability across turns', () => {
  it('keeps the prefix byte-identical over several turns', async () => {
    const { engine, provider } = build(() => ({ text: 'ok' }));
    const sessionId = await openSession(engine);
    for (let n = 0; n < 4; n += 1) {
      const { turnId } = await engine.turnSubmit({
        sessionId,
        prompt: `turn ${n}`,
        attachments: [],
        budget: {},
      });
      await engine.awaitTurn(turnId);
    }
    expect(new Set(provider.prefixes()).size).toBe(1);
    expect(provider.requests.every((r) => r.cachePrefixLength > 0)).toBe(true);
  });
});

describe('Engine.awaitTurn', () => {
  it('rejects for an unknown turn', async () => {
    const { engine } = build([]);
    await expect(engine.awaitTurn('nope')).rejects.toThrow(/unknown turn/);
  });

  it('surfaces a configuration error', async () => {
    const { engine } = build([{ text: 'x' }]);
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: { maxSpendUsd: 1 },
    });
    await expect(engine.awaitTurn(turnId)).rejects.toThrow(/maxSpendUsd/);
  });
});

describe('Engine.sessionClose', () => {
  it('is idempotent for an unknown session', async () => {
    const { engine } = build([]);
    await expect(engine.sessionClose({ sessionId: 'nope' })).resolves.toEqual({ turns: 0 });
  });

  it('cancels an in-flight turn', async () => {
    const { engine } = build([{ text: 'slow', delayMs: 5_000 }]);
    const sessionId = await openSession(engine);
    const { turnId } = await engine.turnSubmit({
      sessionId,
      prompt: 'go',
      attachments: [],
      budget: {},
    });
    await engine.sessionClose({ sessionId });
    const outcome = await engine.awaitTurn(turnId);
    expect(outcome.stopReason).toBe('cancelled');
  });
});
