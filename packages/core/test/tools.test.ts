import { resolve } from 'node:path';
import type { JsonObject, ToolResult } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { type CommandOutcome, NullBroker, type SandboxBroker } from '../src/broker.js';
import { type DispatchOutcome, dispatchToolCall } from '../src/dispatch.js';
import { MemoryFileSystem } from '../src/fs.js';
import { HookBus, type RegisteredHook } from '../src/hooks.js';
import { sequentialIdFactory } from '../src/ids.js';
import { PermissionGate } from '../src/permissions.js';
import { ToolRegistry } from '../src/registry.js';
import type { SearchBackend } from '../src/retrieval.js';
import { builtinTools } from '../src/tools/index.js';
import { ContinuationStore } from '../src/truncate.js';
import type { SubagentRunner } from '../src/types.js';

const ROOT = '/work/repo';

/** A broker that returns scripted output without spawning anything. */
class StubBroker implements SandboxBroker {
  readonly name = 'stub';
  readonly calls: { command: readonly string[]; cwd: string }[] = [];

  constructor(private readonly outcome: CommandOutcome) {}

  enforcement(): 'gate-only' {
    return 'gate-only';
  }

  async exec(request: Parameters<SandboxBroker['exec']>[0]): Promise<CommandOutcome> {
    this.calls.push({ command: request.command, cwd: request.cwd });
    return await Promise.resolve(this.outcome);
  }
}

function ok(over: Partial<Extract<CommandOutcome, { kind: 'completed' }>> = {}): CommandOutcome {
  return {
    kind: 'completed',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    cancelled: false,
    outputCapped: false,
    durationMs: 5,
    enforcement: 'gate-only',
    ...over,
  };
}

interface RunOptions {
  readonly files?: Readonly<Record<string, string>>;
  readonly broker?: SandboxBroker;
  readonly search?: SearchBackend;
  readonly runSubagent?: SubagentRunner;
  readonly hooks?: readonly RegisteredHook[];
  readonly maxResultBytes?: number;
  readonly continuations?: ContinuationStore;
}

interface Runner {
  readonly fs: MemoryFileSystem;
  readonly continuations: ContinuationStore;
  call(name: string, args: JsonObject): Promise<DispatchOutcome>;
}

function runner(options: RunOptions = {}): Runner {
  const nextId = sequentialIdFactory();
  const fs = new MemoryFileSystem(options.files ?? {});
  fs.seedDirectory(ROOT);
  const registry = new ToolRegistry(builtinTools({ nextId }));
  const gate = new PermissionGate({
    workspaceRoot: ROOT,
    // full-access so the gate is not what is under test here.
    sandbox: { mode: 'full-access', writableRoots: [], allowedNetworkHosts: [], commandRules: [] },
    approvals: 'never',
    broker: options.broker ?? new NullBroker(),
    fs,
    nextRequestId: () => nextId('appr'),
    platform: 'linux',
  });
  const hooks = new HookBus();
  for (const hook of options.hooks ?? []) hooks.register(hook);
  const continuations = options.continuations ?? new ContinuationStore(() => nextId('cont'));

  return {
    fs,
    continuations,
    call: async (name, args) =>
      await dispatchToolCall(
        { callId: 'c1', name, arguments: args, step: 0 },
        {
          registry,
          gate,
          hooks,
          continuations,
          workspaceRoot: ROOT,
          sessionId: 'sess_1',
          turnId: 'turn_1',
          limits: { maxResultBytes: options.maxResultBytes ?? 4_096, timeoutMs: 1_000 },
          signal: new AbortController().signal,
          search: options.search,
          todos: [],
          runSubagent: options.runSubagent,
        },
      ),
  };
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function executed(outcome: DispatchOutcome): ToolResult {
  if (outcome.kind !== 'executed') throw new Error('expected the call to execute');
  return outcome.result;
}

describe('read', () => {
  it('returns a window with line numbers and the total', async () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n');
    const result = executed(
      await runner({ files: { [`${ROOT}/a.txt`]: lines } }).call('read', {
        path: 'a.txt',
        offset: 10,
        limit: 3,
      }),
    );
    const text = textOf(result);
    expect(text).toContain('lines: 10-12 of 50');
    expect(text).toContain('10\tline 10');
    expect(text).toContain('next_offset: 13');
    expect(text).not.toContain('13\tline 13');
  });

  it('omits next_offset when the whole file was returned', async () => {
    const result = executed(
      await runner({ files: { [`${ROOT}/a.txt`]: 'one\ntwo' } }).call('read', { path: 'a.txt' }),
    );
    expect(textOf(result)).not.toContain('next_offset');
  });

  it('stops at the token budget rather than the line limit', async () => {
    // The reason `read` exists rather than being `cat`: a 40k-line file must not be able
    // to consume the context window.
    const long = Array.from({ length: 5_000 }, () => 'x'.repeat(200)).join('\n');
    const result = executed(
      await runner({ files: { [`${ROOT}/big.txt`]: long }, maxResultBytes: 5_000_000 }).call(
        'read',
        { path: 'big.txt' },
      ),
    );
    const returned = textOf(result).split('\n').length;
    expect(returned).toBeLessThan(500);
  });

  it('always returns at least one line', async () => {
    // A single line over the token budget would otherwise produce an empty window,
    // which tells the model nothing and costs it a step.
    const result = executed(
      await runner({
        files: { [`${ROOT}/a.txt`]: 'x'.repeat(100_000) },
        maxResultBytes: 1_000_000,
      }).call('read', { path: 'a.txt' }),
    );
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('1\t');
  });

  it('reports a missing file without throwing', async () => {
    const result = executed(await runner().call('read', { path: 'nope.txt' }));
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain('nope.txt');
  });

  it('needs a path or a continuation', async () => {
    const result = executed(await runner().call('read', {}));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('missing path');
  });

  it('redeems a continuation token', async () => {
    const store = new ContinuationStore(() => 'tok_1');
    store.register('bash: pnpm test', ['a', 'b', 'c'].join('\n'));
    const result = executed(
      await runner({ continuations: store }).call('read', {
        continuation: 'tok_1',
        offset: 2,
      }),
    );
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('2\tb');
  });

  it('says so when a token is no longer held', async () => {
    const result = executed(await runner().call('read', { continuation: 'gone' }));
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain('no longer held');
  });
});

describe('write', () => {
  it('writes the file and reports its size', async () => {
    const run = runner();
    const result = executed(await run.call('write', { path: 'out.txt', content: 'hello\nworld' }));
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('bytes: 11');
    await expect(run.fs.readFile(`${ROOT}/out.txt`)).resolves.toBe('hello\nworld');
  });

  it('creates parent directories implicitly through the filesystem layer', async () => {
    const run = runner();
    await run.call('write', { path: 'deep/nested/out.txt', content: 'x' });
    await expect(run.fs.readFile(`${ROOT}/deep/nested/out.txt`)).resolves.toBe('x');
  });
});

describe('edit', () => {
  it('applies an edit and reports the tier, strategy, and validator', async () => {
    const run = runner({ files: { [`${ROOT}/a.ts`]: 'const a = 1;\n' } });
    const outcome = await run.call('edit', {
      path: 'a.ts',
      edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }],
    });
    const result = executed(outcome);
    expect(result.ok).toBe(true);
    const text = textOf(result);
    expect(text).toContain('status: applied');
    expect(text).toContain('tier: search-replace');
    expect(text).toContain('strategy: exact');
    // A claim about evidence, passed through from the applier untouched.
    expect(text).toContain('validator: structural');
    await expect(run.fs.readFile(`${ROOT}/a.ts`)).resolves.toBe('const a = 2;\n');
  });

  it('emits proposed and applied', async () => {
    const outcome = await runner({ files: { [`${ROOT}/a.ts`]: 'const a = 1;\n' } }).call('edit', {
      path: 'a.ts',
      edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }],
    });
    if (outcome.kind !== 'executed') throw new Error('expected execution');
    expect(outcome.emissions.map((e) => e.kind)).toEqual(['edit.proposed', 'edit.applied']);
  });

  it('refuses an ambiguous match and returns the applier message verbatim', async () => {
    const run = runner({ files: { [`${ROOT}/a.ts`]: 'x();\ny();\nx();\n' } });
    const outcome = await run.call('edit', {
      path: 'a.ts',
      edits: [{ search: 'x();', replace: 'z();' }],
    });
    const result = executed(outcome);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ambiguous');
    // Written for a model to retry against; one round of feedback is the highest-value
    // intervention in the loop, so the message crosses unedited.
    expect(textOf(result)).toContain('matched 2 times');
    expect(textOf(result)).toContain("set 'occurrence'");
    // The file is untouched: a refusal is a good outcome.
    await expect(run.fs.readFile(`${ROOT}/a.ts`)).resolves.toBe('x();\ny();\nx();\n');
    if (outcome.kind !== 'executed') return;
    expect(outcome.emissions.map((e) => e.kind)).toEqual(['edit.proposed', 'edit.refused']);
  });

  it('points at write when the file does not exist', async () => {
    const result = executed(
      await runner().call('edit', { path: 'new.ts', edits: [{ search: 'a', replace: 'b' }] }),
    );
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain('Use write');
  });
});

describe('bash', () => {
  it('runs through the broker with an explicit cwd and no shell interpretation', async () => {
    const broker = new StubBroker(ok({ stdout: 'hi\n' }));
    const result = executed(await runner({ broker }).call('bash', { command: 'echo hi' }));
    expect(result.ok).toBe(true);
    expect(broker.calls[0]?.command).toEqual(['bash', '-lc', 'echo hi']);
    expect(broker.calls[0]?.cwd).toBe(resolve(ROOT));
    expect(textOf(result)).toContain('exit: 0');
  });

  it('resolves a relative cwd against the workspace root', async () => {
    // Stateless execution means the working directory is an argument on every call.
    // There is no previous `cd` to inherit.
    const broker = new StubBroker(ok());
    await runner({ broker }).call('bash', { command: 'ls', cwd: 'packages' });
    expect(broker.calls[0]?.cwd).toBe(resolve(ROOT, 'packages'));
  });

  it('reports a failing command with extracted failures', async () => {
    const broker = new StubBroker(
      ok({ exitCode: 1, stdout: 'FAIL  test/a.test.ts\nAssertionError: expected 1 to be 2\n' }),
    );
    const result = executed(await runner({ broker }).call('bash', { command: 'pnpm test' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited with code 1');
    expect(textOf(result)).toContain('failures:');
    expect(textOf(result)).toContain('AssertionError');
  });

  it('reports a program that never started as distinct from a failure', async () => {
    const broker = new StubBroker({
      kind: 'spawn-failed',
      message: "could not run 'bash': spawn bash ENOENT",
      durationMs: 1,
    });
    const result = executed(await runner({ broker }).call('bash', { command: 'ls' }));
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain('did not start');
  });

  it('offers a continuation only when output was actually elided', async () => {
    const noise = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join('\n');
    const broker = new StubBroker(ok({ stdout: noise }));
    const result = executed(
      await runner({ broker, maxResultBytes: 1_024 }).call('bash', { command: 'cat big' }),
    );
    expect(result.truncated).toBe(true);
    expect(result.truncation?.continuation).toBeDefined();

    const small = new StubBroker(ok({ stdout: 'tiny\n' }));
    const smallResult = executed(await runner({ broker: small }).call('bash', { command: 'echo' }));
    expect(smallResult.truncated).toBe(false);
    expect(smallResult.truncation).toBeUndefined();
  });
});

describe('glob, grep, symbols — unavailable is not empty', () => {
  const cases: readonly [string, JsonObject][] = [
    ['glob', { patterns: ['**/*.ts'] }],
    ['grep', { query: 'needle' }],
    ['symbols', { name: 'Thing' }],
  ];

  for (const [name, args] of cases) {
    it(`${name} reports itself unavailable without a backend`, async () => {
      const result = executed(await runner().call(name, args));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('no retrieval backend');
      // The distinction that matters: a model reading an empty result concludes the
      // symbol does not exist and acts on it.
      expect(textOf(result)).toContain('treat this as "unknown" rather than "not present"');
    });
  }

  it('grep returns structured matches when a backend is configured', async () => {
    const search: SearchBackend = {
      name: 'stub',
      search: async () =>
        await Promise.resolve({
          hits: [
            { path: 'src/a.ts', line: 4, column: 2, snippet: '  const needle = 1;', score: 1 },
          ],
          truncated: false,
          notes: [],
        }),
      glob: async () => await Promise.resolve({ paths: [], truncated: false, notes: [] }),
      symbols: async () =>
        await Promise.resolve({ hits: [], truncated: false, extractor: 'none', notes: [] }),
    };
    const result = executed(await runner({ search }).call('grep', { query: 'needle' }));
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('src/a.ts:4:2');
    expect(textOf(result)).toContain('const needle = 1;');
  });

  it('symbols passes the extractor level through unchanged', async () => {
    const search: SearchBackend = {
      name: 'stub',
      search: async () => await Promise.resolve({ hits: [], truncated: false, notes: [] }),
      glob: async () => await Promise.resolve({ paths: [], truncated: false, notes: [] }),
      symbols: async () =>
        await Promise.resolve({
          hits: [
            { path: 'src/a.ts', name: 'Thing', kind: 'class', line: 1, snippet: 'class Thing' },
          ],
          truncated: false,
          // A heuristic answer must never be reported as a parse.
          extractor: 'heuristic',
          notes: ['tree-sitter grammar not present'],
        }),
    };
    const result = executed(await runner({ search }).call('symbols', { name: 'Thing' }));
    expect(textOf(result)).toContain('extractor: heuristic');
    expect(textOf(result)).toContain('note: tree-sitter grammar not present');
  });
});

describe('todo', () => {
  it('emits the full list and summarises by status', async () => {
    const outcome = await runner().call('todo', {
      items: [
        { id: '1', content: 'a', status: 'completed' },
        { id: '2', content: 'b', status: 'pending' },
      ],
    });
    const result = executed(outcome);
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('items: 2');
    if (outcome.kind !== 'executed') return;
    expect(outcome.emissions[0]?.kind).toBe('todo.updated');
  });

  it('rejects an unknown status through the schema', async () => {
    const result = executed(
      await runner().call('todo', { items: [{ id: '1', content: 'a', status: 'almost' }] }),
    );
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain('invalid arguments');
  });
});

describe('task', () => {
  it('delegates and returns only the subagent text', async () => {
    const result = executed(
      await runner({
        runSubagent: async () =>
          await Promise.resolve({
            ok: true,
            text: 'found it in src/a.ts',
            steps: 3,
            stopReason: 'end-turn',
          }),
      }).call('task', { prompt: 'find the thing', tools: ['grep', 'read'] }),
    );
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('found it in src/a.ts');
    expect(textOf(result)).toContain('steps: 3');
  });

  it('says so when no runner is attached', async () => {
    const result = executed(await runner().call('task', { prompt: 'x', tools: ['read'] }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no subagent runner');
  });
});

describe('dispatch — argument validation and hooks', () => {
  it('reports an unknown tool with the list of real ones', async () => {
    const result = executed(await runner().call('teleport', {}));
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("unknown tool 'teleport'");
    expect(textOf(result)).toContain('bash');
  });

  it('reports schema violations for the model to retry against', async () => {
    const result = executed(await runner().call('read', { path: 42 }));
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain('invalid arguments');
    expect(textOf(result)).toContain('path');
  });

  it('re-validates arguments a hook rewrote', async () => {
    // A hook is third-party code and gets no more trust than the model. Skipping
    // validation here would make the hook bus a way around the one place args are
    // checked.
    const result = executed(
      await runner({
        hooks: [{ name: 'sabotage', toolPre: () => ({ kind: 'rewrite', arguments: { path: 7 } }) }],
      }).call('read', { path: 'a.txt' }),
    );
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain('invalid arguments');
  });

  it('honours a hook rewrite that is valid', async () => {
    const run = runner({
      files: { [`${ROOT}/real.txt`]: 'contents' },
      hooks: [
        { name: 'redirect', toolPre: () => ({ kind: 'rewrite', arguments: { path: 'real.txt' } }) },
      ],
    });
    const result = executed(await run.call('read', { path: 'decoy.txt' }));
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('contents');
  });

  it('denies from a hook before the gate is consulted', async () => {
    const outcome = await runner({
      hooks: [{ name: 'policy', toolPre: () => ({ kind: 'deny', reason: 'not allowed here' }) }],
    }).call('write', { path: 'a.txt', content: 'x' });
    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    // Being asked to approve something a local policy already forbids is worse than not
    // being asked.
    expect(outcome.source).toBe('hook');
  });

  it('lets a tool.post hook replace a result', async () => {
    const result = executed(
      await runner({
        files: { [`${ROOT}/a.txt`]: 'secret' },
        hooks: [
          {
            name: 'redact',
            toolPost: (ctx) => ({
              kind: 'replace',
              result: { ...ctx.result, content: [{ type: 'text', text: '[redacted]' }] },
            }),
          },
        ],
      }).call('read', { path: 'a.txt' }),
    );
    expect(textOf(result)).toBe('[redacted]');
  });

  it('records a duration on every executed call', async () => {
    const result = executed(await runner().call('todo', { items: [] }));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
