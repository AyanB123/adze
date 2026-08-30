/**
 * A complete turn, driven by the offline provider.
 *
 * These are the assertions a new surface depends on and cannot easily check for
 * itself: that the event stream is contiguous and typed, that unsubscribing actually
 * stops delivery, that a budget terminates the loop instead of being advisory, that
 * cancellation produces `cancelled` rather than a hang, and that usage arrives with
 * its cache split intact.
 *
 * `seq` contiguity is asserted rather than assumed because a gap is invisible from a
 * surface's side: a dropped event renders as a partial turn, which looks exactly like
 * a model that stopped early.
 */

import { describe, expect, it } from 'vitest';
import type { AdzeEvent } from '../src/index.js';
import { isTerminalEvent } from '../src/index.js';
import { bashStep, eventsOfType, harness, todoStep } from './support.js';

function sequenceIsContiguous(events: readonly AdzeEvent[]): boolean {
  const next = new Map<string, number>();
  for (const event of events) {
    const expected = next.get(event.turnId) ?? 0;
    if (event.seq !== expected) return false;
    next.set(event.turnId, expected + 1);
  }
  return true;
}

describe('a turn', () => {
  it('runs a tool call and a final message, and reports end-turn', async () => {
    const { client, events, stop } = harness({
      script: [todoStep('write the example'), { text: 'Plan recorded.' }],
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'Plan the work.', budget: { maxSteps: 8 } });

    expect(result.stopReason).toBe('end-turn');
    expect(result.text).toBe('Plan recorded.');
    expect(result.steps).toBe(2);
    expect(result.message).toBeUndefined();

    // `todo` declares no effects, so it is never prompted even under `untrusted`, and
    // `tool.started` is emitted only after authorization — its presence means the tool
    // really ran rather than that a call was attempted.
    expect(eventsOfType(events, 'tool.started').map((e) => e.call.name)).toEqual(['todo']);
    expect(eventsOfType(events, 'tool.denied')).toHaveLength(0);
    expect(eventsOfType(events, 'todo.updated')[0]?.items[0]?.content).toBe('write the example');
    expect(eventsOfType(events, 'turn.completed')[0]?.stopReason).toBe('end-turn');
    expect(sequenceIsContiguous(events)).toBe(true);

    stop();
    await client.dispose();
  });

  it('delivers text deltas incrementally rather than as one buffered string', async () => {
    const { client, events, stop } = harness({
      script: [{ textDeltas: ['Adze ', 'streams ', 'text.'] }],
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'Say something.' });

    expect(eventsOfType(events, 'text.delta').map((e) => e.text)).toEqual([
      'Adze ',
      'streams ',
      'text.',
    ]);
    expect(result.text).toBe('Adze streams text.');

    stop();
    await client.dispose();
  });

  it('stops delivering to a listener that has unsubscribed', async () => {
    const { client, stop } = harness({ script: [{ text: 'one' }, { text: 'two' }] });
    const session = await client.createSession();

    const seen: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      seen.push(event.type);
    });

    await session.run({ prompt: 'first' });
    const afterFirst = seen.length;
    expect(afterFirst).toBeGreaterThan(0);

    unsubscribe();
    // Idempotent: a surface unsubscribing in both a cleanup path and an effect
    // teardown must not need to guard.
    unsubscribe();

    await session.run({ prompt: 'second' });
    expect(seen.length).toBe(afterFirst);

    stop();
    await client.dispose();
  });

  it('scopes a session subscription to that session', async () => {
    const { client, stop } = harness({ script: [{ text: 'ok' }, { text: 'ok' }] });
    const first = await client.createSession();
    const second = await client.createSession();

    const firstOnly: string[] = [];
    const off = first.subscribe((event) => firstOnly.push(event.sessionId));

    await second.run({ prompt: 'on the other session' });
    expect(firstOnly).toHaveLength(0);

    await first.run({ prompt: 'on this session' });
    expect(new Set(firstOnly)).toEqual(new Set([first.id]));

    off();
    stop();
    await client.dispose();
  });

  it('lets a listener unsubscribe from inside its own callback', async () => {
    const { client, stop } = harness({ script: [{ text: 'done' }] });
    const session = await client.createSession();

    const seen: string[] = [];
    const off = session.subscribe((event) => {
      seen.push(event.type);
      // The ordinary shape of "wait for the terminal event". Mutating the subscriber
      // set mid-publish must not perturb the iteration.
      if (isTerminalEvent(event)) off();
    });

    await session.run({ prompt: 'go' });
    expect(seen.at(-1)).toBe('turn.completed');

    await session.run({ prompt: 'again' });
    expect(seen.filter((type) => type === 'turn.completed')).toHaveLength(1);

    stop();
    await client.dispose();
  });

  it('does not let a throwing listener break the turn', async () => {
    const failures: unknown[] = [];
    const { client, stop } = harness({
      script: [{ text: 'still finished' }],
      onListenerError: (error) => failures.push(error),
    });
    const session = await client.createSession();

    const off = session.subscribe(() => {
      throw new Error('listener is broken');
    });

    const result = await session.run({ prompt: 'go' });

    expect(result.stopReason).toBe('end-turn');
    expect(result.text).toBe('still finished');
    expect(failures.length).toBeGreaterThan(0);
    expect((failures[0] as Error).message).toBe('listener is broken');

    off();
    stop();
    await client.dispose();
  });
});

describe('budgets', () => {
  it('terminates the loop at maxSteps and says so', async () => {
    const { client, events, stop } = harness({
      script: [todoStep('one'), todoStep('two'), todoStep('three')],
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'keep going', budget: { maxSteps: 2 } });

    // A step is a model round-trip *plus* its tool calls: cutting the tools off would
    // leave an assistant message with unanswered calls, which most providers reject.
    expect(result.stopReason).toBe('max-steps');
    expect(result.steps).toBe(2);
    expect(result.message).toContain('step budget exhausted');
    expect(eventsOfType(events, 'tool.started')).toHaveLength(2);

    stop();
    await client.dispose();
  });

  it('terminates on a token ceiling with budget-exhausted, not max-steps', async () => {
    const { client, stop } = harness({
      script: [todoStep('one'), todoStep('two'), { text: 'never reached' }],
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'burn tokens', budget: { maxTokens: 150 } });

    // `max-steps` is the ceiling a user sets on purpose; the others mean something got
    // away from them. Collapsing the two would put a routine stop and a runaway in the
    // same bucket.
    expect(result.stopReason).toBe('budget-exhausted');
    expect(result.message).toContain('token budget exhausted');

    stop();
    await client.dispose();
  });

  it('applies the client default budget to a turn that carries none', async () => {
    const { client, stop } = harness({
      script: [todoStep('one'), todoStep('two')],
      budget: { maxSteps: 1 },
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'go' });

    expect(result.stopReason).toBe('max-steps');
    expect(result.steps).toBe(1);

    stop();
    await client.dispose();
  });

  it('lets a turn override the client default budget', async () => {
    const { client, stop } = harness({
      script: [todoStep('one'), todoStep('two'), { text: 'finished' }],
      budget: { maxSteps: 1 },
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'go', budget: { maxSteps: 8 } });

    expect(result.stopReason).toBe('end-turn');
    expect(result.text).toBe('finished');

    stop();
    await client.dispose();
  });
});

describe('cancellation', () => {
  it('stops a turn in flight and reports cancelled', async () => {
    const { client, stop } = harness({ script: [{ delayMs: 30_000, text: 'too late' }] });
    const session = await client.createSession();

    const handle = await session.submit({ prompt: 'something slow' });
    expect(handle.cancel()).toBe(true);

    const result = await handle.result();
    expect(result.stopReason).toBe('cancelled');
    expect(result.text).toBe('');

    stop();
    await client.dispose();
  });

  it('reports false when the turn had already finished, rather than erroring', async () => {
    const { client, stop } = harness({ script: [{ text: 'quick' }] });
    const session = await client.createSession();

    const handle = await session.submit({ prompt: 'go' });
    await handle.result();

    // A cancel racing a completion is normal. Making it an error would force every
    // surface to special-case a race it cannot avoid.
    expect(handle.cancel()).toBe(false);

    stop();
    await client.dispose();
  });

  it('returns the same result from a second result() call', async () => {
    const { client, stop } = harness({ script: [{ text: 'once' }] });
    const session = await client.createSession();

    const handle = await session.submit({ prompt: 'go' });
    const first = await handle.result();
    // Core's `awaitTurn` is single-shot; without memoization the second call would
    // throw `unknown turn` at any consumer that both awaits and reports.
    const second = await handle.result();

    expect(second).toBe(first);

    stop();
    await client.dispose();
  });
});

describe('usage, cost, and cache hit rate', () => {
  it('reports the token split and derives the cache hit rate from it', async () => {
    const { client, stop } = harness({
      script: [{ text: 'done', inputTokens: 100, cachedInputTokens: 300, outputTokens: 40 }],
      withPrices: true,
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'go' });

    // The three counts do not overlap, so prompt size is input + cached input.
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.cachedInputTokens).toBe(300);
    expect(result.usage.outputTokens).toBe(40);
    expect(result.cacheHitRate).toBeCloseTo(0.75, 10);

    // 100/1e6*3 + 300/1e6*0.3 + 40/1e6*15
    expect(result.cost?.currency).toBe('USD');
    expect(result.cost?.totalUsd).toBeCloseTo(0.00099, 10);

    stop();
    await client.dispose();
  });

  it('reports cost as unknown rather than zero when the provider has no prices', async () => {
    const { client, stop } = harness({ script: [{ text: 'done' }] });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'go' });

    // A wrong cost figure is worse than no cost figure, because it gets quoted.
    expect(result.cost).toBeUndefined();
    expect(result.usage.outputTokens).toBeGreaterThan(0);

    stop();
    await client.dispose();
  });

  it('accumulates session totals across turns', async () => {
    const { client, stop } = harness({
      script: [
        { text: 'one', inputTokens: 10, cachedInputTokens: 30, outputTokens: 5 },
        { text: 'two', inputTokens: 10, cachedInputTokens: 30, outputTokens: 5 },
      ],
      withPrices: true,
    });
    const session = await client.createSession();

    await session.run({ prompt: 'first' });
    await session.run({ prompt: 'second' });

    const usage = session.usage();
    expect(usage.turns).toBe(2);
    expect(usage.usage.inputTokens).toBe(20);
    expect(usage.usage.cachedInputTokens).toBe(60);
    expect(usage.usage.outputTokens).toBe(10);
    // Recomputed from the summed split rather than averaged: a small step and a large
    // one do not contribute equally to "what fraction of this turn's prompt was cached".
    expect(usage.cacheHitRate).toBeCloseTo(0.75, 10);
    expect(usage.cost?.totalUsd).toBeGreaterThan(0);

    stop();
    await client.dispose();
  });
});

describe('a failing provider', () => {
  it('reports error as a stop reason rather than throwing out of run()', async () => {
    const { client, events, stop } = harness({ script: [{ fails: 'no credentials configured' }] });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'go' });

    expect(result.stopReason).toBe('error');
    expect(result.message).toContain('no credentials configured');
    expect(eventsOfType(events, 'turn.completed')[0]?.stopReason).toBe('error');

    stop();
    await client.dispose();
  });

  it('keeps a refusal distinct from an error', async () => {
    const { client, stop } = harness({
      script: [bashStep('rm -rf /')],
      approvals: 'on-request',
      onApprovalRequest: (request) => ({ requestId: request.requestId, decision: 'abort' }),
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'go' });

    // The gate did its job. Collapsing this into `error` would make a working safety
    // mechanism indistinguishable from a crash in every metric computed from runs.
    expect(result.stopReason).toBe('refused');

    stop();
    await client.dispose();
  });
});
