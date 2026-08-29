import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, Session } from '../src/session.js';

function session(): Session {
  return new Session({
    id: 's1',
    workspaceRoot: '/work',
    model: { provider: 'p', model: 'm' },
    sandbox: {
      mode: 'workspace-write',
      writableRoots: [],
      allowedNetworkHosts: [],
      commandRules: [],
    },
    approvals: 'on-request',
  });
}

describe('Session — strictly linear history', () => {
  it('appends and exposes history as readonly', () => {
    const s = session();
    s.append({ role: 'user', origin: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(s.history).toHaveLength(1);
  });

  it('detects a ragged history', () => {
    const s = session();
    s.append({
      role: 'assistant',
      origin: 'model',
      content: [],
      toolCalls: [
        { callId: 'a', name: 'x', arguments: {} },
        { callId: 'b', name: 'x', arguments: {} },
      ],
    });
    s.append({ role: 'tool', origin: 'tool', callId: 'a', name: 'x', ok: true, content: [] });
    // One call unanswered: rejected by most providers and unreplayable.
    expect(s.historyIsLinear()).toBe(false);
  });

  it('detects a mismatched call id', () => {
    const s = session();
    s.append({
      role: 'assistant',
      origin: 'model',
      content: [],
      toolCalls: [{ callId: 'a', name: 'x', arguments: {} }],
    });
    s.append({ role: 'tool', origin: 'tool', callId: 'wrong', name: 'x', ok: true, content: [] });
    expect(s.historyIsLinear()).toBe(false);
  });

  it('accepts a well-formed history', () => {
    const s = session();
    s.append({
      role: 'assistant',
      origin: 'model',
      content: [],
      toolCalls: [{ callId: 'a', name: 'x', arguments: {} }],
    });
    s.append({ role: 'tool', origin: 'tool', callId: 'a', name: 'x', ok: true, content: [] });
    s.append({ role: 'assistant', origin: 'model', content: [], toolCalls: [] });
    expect(s.historyIsLinear()).toBe(true);
  });

  it('compaction is the only non-append, and it replaces history wholesale', () => {
    const s = session();
    s.append({ role: 'user', origin: 'user', content: [{ type: 'text', text: 'a' }] });
    s.append({ role: 'assistant', origin: 'model', content: [], toolCalls: [] });
    s.compact('earlier: the user asked for a');
    expect(s.history).toHaveLength(1);
    expect(s.history[0]?.origin).toBe('engine');
  });

  it('snapshots to plain JSON', () => {
    // The replay artifact. A snapshot plus the same script reproduces a run, which is
    // what makes a trajectory checkable by someone who was not there.
    const s = session();
    s.append({ role: 'user', origin: 'user', content: [{ type: 'text', text: 'a' }] });
    const snapshot = s.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('accumulates usage across turns', () => {
    const s = session();
    s.recordUsage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, cacheHitRate: 0 });
    s.recordUsage({ inputTokens: 10, cachedInputTokens: 30, outputTokens: 1, cacheHitRate: 0.75 });
    expect(s.usage.inputTokens).toBe(20);
    expect(s.usage.cachedInputTokens).toBe(30);
    expect(s.usage.cacheHitRate).toBeCloseTo(30 / 50, 10);
  });
});

describe('InMemorySessionStore', () => {
  it('creates, reads, lists, and deletes', async () => {
    const store = new InMemorySessionStore();
    const s = session();
    await store.create(s);
    await expect(store.get('s1')).resolves.toBe(s);
    await expect(store.list()).resolves.toHaveLength(1);
    await expect(store.create(s)).rejects.toThrow(/already exists/);
    await store.delete('s1');
    await expect(store.get('s1')).resolves.toBeUndefined();
  });

  it('deleting an unknown session is a no-op', async () => {
    const store = new InMemorySessionStore();
    await expect(store.delete('nope')).resolves.toBeUndefined();
  });
});
