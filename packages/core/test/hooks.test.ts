import type { ToolResult } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { HookBus, type RegisteredHook } from '../src/hooks.js';

function bus(hooks: readonly RegisteredHook[], timeoutMs?: number): HookBus {
  const created = new HookBus(timeoutMs);
  for (const hook of hooks) created.register(hook);
  return created;
}

const preContext = {
  sessionId: 's',
  turnId: 't',
  callId: 'c',
  name: 'bash',
  arguments: { command: 'rm -rf /' },
};

const result: ToolResult = { callId: 'c', ok: true, content: [], truncated: false };

describe('HookBus — tool.pre can deny', () => {
  it('denies and names the hook', async () => {
    const outcome = await bus([
      { name: 'policy', toolPre: () => ({ kind: 'deny', reason: 'no destructive commands' }) },
    ]).fireToolPre(preContext);

    expect(outcome.kind).toBe('deny');
    if (outcome.kind !== 'deny') return;
    expect(outcome.reason).toContain("hook 'policy'");
    expect(outcome.reason).toContain('no destructive commands');
  });

  it('short-circuits on the first denial', async () => {
    const seen: string[] = [];
    const outcome = await bus([
      {
        name: 'first',
        toolPre: () => {
          seen.push('first');
          return { kind: 'deny', reason: 'nope' };
        },
      },
      {
        name: 'second',
        toolPre: () => {
          seen.push('second');
          return { kind: 'continue' };
        },
      },
    ]).fireToolPre(preContext);

    expect(outcome.kind).toBe('deny');
    // Asking the rest is pointless and lets them observe a call that will not happen.
    expect(seen).toEqual(['first']);
  });

  it('continues when no hook objects', async () => {
    const outcome = await bus([
      { name: 'watch', toolPre: () => ({ kind: 'continue' }) },
    ]).fireToolPre(preContext);
    expect(outcome.kind).toBe('continue');
  });
});

describe('HookBus — tool.pre can rewrite arguments', () => {
  it('returns the rewritten arguments', async () => {
    const outcome = await bus([
      {
        name: 'normalize',
        toolPre: (ctx) => ({
          kind: 'rewrite',
          arguments: { ...ctx.arguments, command: 'ls' },
        }),
      },
    ]).fireToolPre(preContext);

    expect(outcome.kind).toBe('rewrite');
    if (outcome.kind !== 'rewrite') return;
    expect(outcome.arguments.command).toBe('ls');
  });

  it('chains rewrites so hooks compose', async () => {
    const outcome = await bus([
      { name: 'a', toolPre: (ctx) => ({ kind: 'rewrite', arguments: { ...ctx.arguments, a: 1 } }) },
      { name: 'b', toolPre: (ctx) => ({ kind: 'rewrite', arguments: { ...ctx.arguments, b: 2 } }) },
    ]).fireToolPre(preContext);

    expect(outcome.kind).toBe('rewrite');
    if (outcome.kind !== 'rewrite') return;
    expect(outcome.arguments).toMatchObject({ a: 1, b: 2 });
  });

  it('lets a later hook deny a rewritten call', async () => {
    const outcome = await bus([
      { name: 'a', toolPre: () => ({ kind: 'rewrite', arguments: { command: 'sudo rm' } }) },
      {
        name: 'b',
        toolPre: (ctx) =>
          String(ctx.arguments.command).startsWith('sudo')
            ? { kind: 'deny', reason: 'no sudo' }
            : { kind: 'continue' },
      },
    ]).fireToolPre(preContext);

    expect(outcome.kind).toBe('deny');
  });
});

describe('HookBus — tool.pre fails closed', () => {
  it('denies when a hook times out', async () => {
    const outcome = await bus(
      [
        {
          name: 'slow',
          timeoutMs: 10,
          toolPre: async () => await new Promise(() => undefined),
        },
      ],
      10,
    ).fireToolPre(preContext);

    // An unanswered veto is not consent. Failing open would let a flaky or slow hook
    // void the policy it was installed to enforce, silently.
    expect(outcome.kind).toBe('deny');
    if (outcome.kind !== 'deny') return;
    expect(outcome.reason).toContain('did not answer');
    expect(outcome.reason).toContain('treated as a denial');
  });

  it('denies when a hook throws', async () => {
    const outcome = await bus([
      {
        name: 'broken',
        toolPre: () => {
          throw new Error('boom');
        },
      },
    ]).fireToolPre(preContext);

    expect(outcome.kind).toBe('deny');
    if (outcome.kind !== 'deny') return;
    expect(outcome.reason).toContain('boom');
  });
});

describe('HookBus — the observing hooks fail open', () => {
  it('turnStart collects injected context and skips a slow hook', async () => {
    const injected = await bus(
      [
        { name: 'slow', timeoutMs: 10, turnStart: async () => await new Promise(() => undefined) },
        { name: 'fast', turnStart: () => ({ inject: [{ type: 'text', text: 'note' }] }) },
      ],
      10,
    ).fireTurnStart({ sessionId: 's', turnId: 't', prompt: 'p', cacheEpoch: 0 });

    // Enriching hooks are not permission boundaries, so a missing answer costs context
    // rather than a guarantee.
    expect(injected).toHaveLength(1);
  });

  it('turnStart survives a throwing hook', async () => {
    const injected = await bus([
      {
        name: 'broken',
        turnStart: () => {
          throw new Error('boom');
        },
      },
      { name: 'ok', turnStart: () => ({ inject: [{ type: 'text', text: 'kept' }] }) },
    ]).fireTurnStart({ sessionId: 's', turnId: 't', prompt: 'p', cacheEpoch: 0 });

    expect(injected).toHaveLength(1);
  });

  it('toolPost can replace a result, last write winning', async () => {
    const replaced = await bus([
      {
        name: 'a',
        toolPost: () => ({
          kind: 'replace',
          result: {
            callId: 'c',
            ok: true,
            content: [{ type: 'text', text: 'a' }],
            truncated: false,
          },
        }),
      },
      {
        name: 'b',
        toolPost: () => ({
          kind: 'replace',
          result: {
            callId: 'c',
            ok: true,
            content: [{ type: 'text', text: 'b' }],
            truncated: false,
          },
        }),
      },
    ]).fireToolPost({ sessionId: 's', turnId: 't', callId: 'c', name: 'bash', result });

    expect(replaced.content[0]).toEqual({ type: 'text', text: 'b' });
  });

  it('toolPost leaves the result alone when a hook fails', async () => {
    const unchanged = await bus([
      {
        name: 'broken',
        toolPost: () => {
          throw new Error('boom');
        },
      },
    ]).fireToolPost({ sessionId: 's', turnId: 't', callId: 'c', name: 'bash', result });

    expect(unchanged).toBe(result);
  });

  it('turnEnd runs every hook even when one throws', async () => {
    const ran: string[] = [];
    await bus([
      {
        name: 'broken',
        turnEnd: () => {
          ran.push('broken');
          throw new Error('boom');
        },
      },
      { name: 'ok', turnEnd: () => void ran.push('ok') },
    ]).fireTurnEnd({
      sessionId: 's',
      turnId: 't',
      stopReason: 'end-turn',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheHitRate: 0 },
      steps: 1,
    });

    expect(ran).toEqual(['broken', 'ok']);
  });
});

describe('HookBus — registration', () => {
  it('disposing removes the hook', async () => {
    const created = new HookBus();
    const handle = created.register({
      name: 'temp',
      toolPre: () => ({ kind: 'deny', reason: 'nope' }),
    });
    expect(created.size).toBe(1);
    handle.dispose();
    expect(created.size).toBe(0);
    expect((await created.fireToolPre(preContext)).kind).toBe('continue');
  });
});
